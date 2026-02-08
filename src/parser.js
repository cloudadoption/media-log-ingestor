const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi', '.m4v', '.mkv'];
const DOC_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt'];

// Matches: ![alt](url "title") or ![alt](url)
// Group 1: alt text, Group 2: url, Group 3: optional title
const MARKDOWN_IMAGE_INLINE_REGEX = /!\[([^\]]*)\]\(([^\s"')]+)(?:\s+"([^"]+)")?\)/g;
const MARKDOWN_IMAGE_REFERENCE_REGEX = /!\[([^\]]*)\]\[([^\]]+)\]/g;
const MARKDOWN_REFERENCE_DEFINITION_REGEX = /^\[([^\]]+)\]:\s*([^\s"]+)(?:\s+"([^"]+)")?$/gm;
const MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\(([^\s"')]+)(?:\s+"([^"]+)")?\)/g;

// Content type mappings for medialog API
const CONTENT_TYPE_MAP = {
  // Raster images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  // Videos
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
};

export function getContentType(url) {
  const lowerUrl = url.toLowerCase();
  const ext = Object.keys(CONTENT_TYPE_MAP).find((e) => lowerUrl.includes(e));
  return ext ? CONTENT_TYPE_MAP[ext] : null;
}

// Extract width and height from URL fragment (#width=X&height=Y)
export function extractDimensions(url) {
  const match = url.match(/#width=(\d+)&height=(\d+)/);
  if (match) {
    return {
      width: match[1],
      height: match[2],
    };
  }
  return null;
}

// Extract media hash from URL (e.g., media_abc123def.jpg -> abc123def)
export function extractMediaHash(url) {
  const match = url.match(/media_([a-f0-9]+)\./);
  return match ? match[1] : null;
}

function isNonImageMedia(url) {
  const lowerUrl = url.toLowerCase();

  // Check for video or document extensions (but not images)
  return VIDEO_EXTENSIONS.some((ext) => lowerUrl.includes(ext))
         || DOC_EXTENSIONS.some((ext) => lowerUrl.includes(ext));
}

export function extractMediaReferences(markdown, sourcePath, org, repo, ref) {
  const mediaRefs = [];
  const seen = new Set();
  const references = new Map();

  // Convert path to full URL for contentSourcePath
  const sourceUrl = `https://${ref}--${repo}--${org}.aem.page${sourcePath}`;

  const addMedia = (path, altText = '') => {
    if (seen.has(path)) return;
    seen.add(path);

    // Operation types: 'ingest' (initial add), 'reuse' (used again), 'remove' (deleted)
    // For retroactive backfill, we use 'ingest'
    const entry = {
      owner: org,
      repo,
      operation: 'ingest',
      path,
      contentSourcePath: sourceUrl,
      contentSourceType: 'markup',
    };

    // Add content type if we can determine it
    const contentType = getContentType(path);
    if (contentType) {
      entry.contentType = contentType;
    }

    // Extract width and height from URL fragment if present
    const dimensions = extractDimensions(path);
    if (dimensions) {
      entry.width = dimensions.width;
      entry.height = dimensions.height;
    }

    // Only include alt if there's actual alt text content
    if (altText && altText.trim()) {
      entry.alt = altText.trim();
    }

    mediaRefs.push(entry);
  };

  // Extract reference definitions
  let match = MARKDOWN_REFERENCE_DEFINITION_REGEX.exec(markdown);
  while (match !== null) {
    const [, refId, url, title] = match;
    references.set(refId.toLowerCase(), { url: url.trim(), title });
    match = MARKDOWN_REFERENCE_DEFINITION_REGEX.exec(markdown);
  }

  // Extract inline images
  MARKDOWN_IMAGE_INLINE_REGEX.lastIndex = 0;
  match = MARKDOWN_IMAGE_INLINE_REGEX.exec(markdown);
  while (match !== null) {
    const [, altText, url, title] = match;
    if (url && url.trim()) {
      // Prefer title over alt text from brackets
      const finalAlt = title || altText;
      addMedia(url, finalAlt);
    }
    match = MARKDOWN_IMAGE_INLINE_REGEX.exec(markdown);
  }

  // Extract reference-style images
  MARKDOWN_IMAGE_REFERENCE_REGEX.lastIndex = 0;
  match = MARKDOWN_IMAGE_REFERENCE_REGEX.exec(markdown);
  while (match !== null) {
    const [, altText, refId] = match;
    const reference = references.get(refId.toLowerCase());
    if (reference) {
      // Prefer reference title over alt text from brackets
      const finalAlt = reference.title || altText;
      addMedia(reference.url, finalAlt);
    }
    match = MARKDOWN_IMAGE_REFERENCE_REGEX.exec(markdown);
  }

  // Extract non-image media from links
  MARKDOWN_LINK_REGEX.lastIndex = 0;
  match = MARKDOWN_LINK_REGEX.exec(markdown);
  while (match !== null) {
    const [, , url] = match;
    if (isNonImageMedia(url)) {
      addMedia(url);
    }
    match = MARKDOWN_LINK_REGEX.exec(markdown);
  }

  return mediaRefs;
}

export function batchEntries(entries, batchSize = 10) {
  const batches = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    batches.push(entries.slice(i, i + batchSize));
  }
  return batches;
}
