export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export async function readUpload(request) {
  const contentType = request.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
    throw fail('Upload a file using multipart/form-data.', 415);
  }
  const maxBody = MAX_FILE_BYTES + 65536;
  if (Number(request.headers['content-length']) > maxBody) throw fail('File exceeds the 10 MB limit.', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBody) throw fail('File exceeds the 10 MB limit.', 413);
    chunks.push(chunk);
  }
  let form;
  try {
    form = await new Request('http://localhost/upload', {
      method: 'POST', headers: { 'content-type': contentType }, body: Buffer.concat(chunks),
    }).formData();
  } catch { throw fail('Invalid multipart upload.'); }
  const files = form.getAll('file');
  if (files.length !== 1 || typeof files[0]?.arrayBuffer !== 'function') throw fail('Attach exactly one file.');
  for (const key of form.keys()) if (!['file', 'dataset_id'].includes(key)) throw fail('Unexpected upload field.');
  if (form.getAll('dataset_id').length > 1) throw fail('Provide only one dataset_id.');
  const file = files[0];
  const name = file.name;
  if (!name || name.length > 180 || /[\\/\x00-\x1f]/.test(name) || !/\.(txt|md|pdf)$/i.test(name)) {
    throw fail('Attach a TXT, Markdown (.md), or PDF file with a valid filename.', 415);
  }
  if (!file.size) throw fail('The attached file is empty.');
  if (file.size > MAX_FILE_BYTES) throw fail('File exceeds the 10 MB limit.', 413);
  const datasetId = form.get('dataset_id') ?? 'local-documents';
  if (typeof datasetId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(datasetId)) throw fail('Invalid dataset_id.');
  return { filename: name, content: Buffer.from(await file.arrayBuffer()), datasetId };
}
