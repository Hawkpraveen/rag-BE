import { connectMongoDB, closeMongoDB, readSQLiteSnapshot, loadDataset } from '../src/services/mongodbData.js';

try {
  const snapshot = await readSQLiteSnapshot();
  console.log(`Loading ${snapshot.documents.length} documents and ${snapshot.chunks.length} existing vectors.`);
  const db = await connectMongoDB();
  console.log('MongoDB connected. Creating dataset and vector index; readiness may take two minutes.');
  console.log(JSON.stringify(await loadDataset(db, snapshot, process.argv[2] || 'local-documents'), null, 2));
} catch (error) {
  // Avoid printing driver errors that might contain the connection URI.
  const known = /^(MongoDB connection failed|MongoDB authentication failed|Set MONGODB_URI|The SQLite dataset|Vector index is not ready|MongoDB vector index build failed)/;
  console.error(known.test(error.message) ? error.message :
    'Dataset load failed. Check the MongoDB driver installation, Python path, source index and Atlas Vector Search permissions.');
  process.exitCode = 1;
} finally { await closeMongoDB(); }
