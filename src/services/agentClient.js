import './mongodbData.js';

async function requestAgent(path, options, timeout) {
  const agentUrl = process.env.AGENT_URL || 'http://127.0.0.1:3000';
  try {
    const response = await fetch(agentUrl.replace(/\/$/, '') + path, {
      ...options, signal: AbortSignal.timeout(timeout),
    });
    return { status: response.status, data: await response.json() };
  } catch (error) {
    return { status: error.name === 'TimeoutError' ? 504 : 502, data: { detail:
      error.name === 'TimeoutError' ? 'The agent timed out. Try a smaller document.'
        : 'Cannot reach the RAG agent. Check AGENT_URL in rag-BE/.env and start the agent with python run.py.' } };
  }
}

export function callAgent(path, body, timeout = 210000) {
  return requestAgent(path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, timeout);
}

export function callAgentFile(path, filename, content, timeout = 210000) {
  return requestAgent(path, { method: 'POST', headers: {
    'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(filename),
  }, body: content }, timeout);
}
