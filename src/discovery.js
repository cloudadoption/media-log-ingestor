import { fetch } from '@adobe/fetch';

const ADMIN_API = 'https://admin.hlx.page';

export async function createBulkStatusJob(org, site, ref, pathFilter, token) {
  const url = `${ADMIN_API}/status/${org}/${site}/${ref}/*`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      paths: [pathFilter || '/*'],
      select: ['preview']
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to create job: ${response.status} - ${text}`);
  }

  const data = await response.json();

  if (!data.job || data.job.state !== 'created') {
    throw new Error('Job creation failed or returned unexpected state');
  }

  return {
    jobId: data.job.name,
    jobUrl: data.links?.self
  };
}

export async function pollJobStatus(jobUrl, token, pollInterval, onProgress) {
  const response = await fetch(jobUrl, {
    headers: {
      Authorization: `token ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch job status: ${response.status}`);
  }

  const { state, progress } = await response.json();

  if (onProgress && progress) {
    onProgress(progress);
  }

  if (state !== 'completed' && state !== 'stopped') {
    await new Promise((resolve) => {
      setTimeout(resolve, pollInterval);
    });
    return pollJobStatus(jobUrl, token, pollInterval, onProgress);
  }

  return state;
}

export async function getJobDetails(jobUrl, token) {
  const detailsUrl = `${jobUrl}/details`;
  const response = await fetch(detailsUrl, {
    headers: {
      Authorization: `token ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch job details: ${response.status}`);
  }

  const { data } = await response.json();
  return data?.resources || [];
}

export async function fetchMarkdown(org, site, ref, resourcePath, token) {
  let fetchPath;
  if (resourcePath.endsWith('.md')) {
    fetchPath = resourcePath;
  } else if (resourcePath.endsWith('/')) {
    fetchPath = `${resourcePath}index.md`;
  } else {
    fetchPath = `${resourcePath}.md`;
  }

  const url = `${ADMIN_API}/preview/${org}/${site}/${ref}${fetchPath}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `token ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch markdown: ${response.status}`);
  }

  return response.text();
}

const MEDIA_EXTENSIONS = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg',
  '.mp4', '.mov', '.webm', '.avi', '.m4v', '.mkv',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'
];

const IGNORE_EXTENSIONS = [
  '.json', '.yaml', '.yml', '.xml', '.txt', '.csv',
  '.js', '.css', '.html', '.ico',
  '.zip', '.tar', '.gz'
];

export function isMediaFile(path) {
  if (!path) return false;
  const lowerPath = path.toLowerCase();
  return MEDIA_EXTENSIONS.some((ext) => lowerPath.endsWith(ext));
}

export function shouldProcessResource(resource) {
  const { path } = resource;

  if (!path) {
    return false;
  }

  const lowerPath = path.toLowerCase();

  if (IGNORE_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))) {
    return false;
  }

  return true;
}
