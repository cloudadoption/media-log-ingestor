const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi', '.m4v', '.mkv'];
const DOC_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt'];

// Matches: ![alt](url "title") or ![alt](url)
// Group 1: alt text, Group 2: url, Group 3: optional title
const MARKDOWN_IMAGE_INLINE_REGEX = /!\[([^\]]*)\]\(([^\s"')]+)(?:\s+"([^"]+)")?\)/g;
const MARKDOWN_IMAGE_REFERENCE_REGEX = /!\[([^\]]*)\]\[([^\]]+)\]/g;
const MARKDOWN_REFERENCE_DEFINITION_REGEX = /^\[([^\]]+)\]:\s*([^\s"]+)(?:\s+"([^"]+)")?$/gm;
const MARKDOWN_LINK_REGEX = /\[([^\]]*)\]\(([^\s"')]+)(?:\s+"([^"]+)")?\)/g;

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

  // Convert path to full URL for sourcePath
  const sourceUrl = `https://${ref}--${repo}--${org}.aem.page${sourcePath}`;

  const addMedia = (path, altText = '') => {
    if (seen.has(path)) return;
    seen.add(path);

    const entry = {
      action: 'add',
      path,
      sourcePath: sourceUrl
    };

    // Only include alt if there's actual alt text content
    if (altText && altText.trim()) {
      entry.alt = altText.trim();
    }

    mediaRefs.push(entry);
  };

  let match;

  /* eslint-disable no-cond-assign */
  while ((match = MARKDOWN_REFERENCE_DEFINITION_REGEX.exec(markdown)) !== null) {
    const [, refId, url, title] = match;
    references.set(refId.toLowerCase(), { url: url.trim(), title });
  }

  MARKDOWN_IMAGE_INLINE_REGEX.lastIndex = 0;
  while ((match = MARKDOWN_IMAGE_INLINE_REGEX.exec(markdown)) !== null) {
    const [, altText, url, title] = match;
    if (url && url.trim()) {
      // Prefer title over alt text from brackets
      const finalAlt = title || altText;
      addMedia(url, finalAlt);
    }
  }

  MARKDOWN_IMAGE_REFERENCE_REGEX.lastIndex = 0;
  while ((match = MARKDOWN_IMAGE_REFERENCE_REGEX.exec(markdown)) !== null) {
    const [, altText, refId] = match;
    const reference = references.get(refId.toLowerCase());
    if (reference) {
      // Prefer reference title over alt text from brackets
      const finalAlt = reference.title || altText;
      addMedia(reference.url, finalAlt);
    }
  }

  MARKDOWN_LINK_REGEX.lastIndex = 0;
  while ((match = MARKDOWN_LINK_REGEX.exec(markdown)) !== null) {
    const [, , url] = match;
    if (isNonImageMedia(url)) {
      addMedia(url);
    }
  }
  /* eslint-enable no-cond-assign */

  return mediaRefs;
}

export function batchEntries(entries, batchSize = 10) {
  const batches = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    batches.push(entries.slice(i, i + batchSize));
  }
  return batches;
}
