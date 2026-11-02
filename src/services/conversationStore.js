import { connectMongoDB } from './mongodbData.js';

// One document per turn keeps the question, answer and sources together.
export function createConversationStore(connect = connectMongoDB) {
  let ready;
  async function db() {
    const database = await connect();
    ready ??= Promise.all([
      database.collection('conversation_histories').createIndex({ conversation_code: 1, created_at: -1, _id: -1 }),
      database.collection('provider_usage_logs').createIndex({ request_id: 1, call_index: 1 }, { unique: true }),
    ]).catch(error => { ready = undefined; throw error; });
    await ready;
    return database;
  }
  return {
    async start(turn) {
      const database = await db();
      try {
        await database.collection('conversation_histories').insertOne(turn);
        return null;
      } catch (error) {
        if (error.code !== 11000) throw error;
        return database.collection('conversation_histories').findOne({ _id: turn._id });
      }
    },
    async finish(id, result, usage) {
      const database = await db();
      const session = database.client.startSession();
      try {
        // A completed turn and its usage records must become durable together.
        await session.withTransaction(async () => {
          await database.collection('conversation_histories').updateOne({ _id: id }, { $set: result }, { session });
          if (usage.length) await database.collection('provider_usage_logs').insertMany(usage, { session });
        });
      } finally { await session.endSession(); }
    },
    async list() {
      const database = await db();
      return database.collection('conversation_histories').aggregate([
        { $sort: { created_at: 1, _id: 1 } },
        { $group: { _id: '$conversation_code', title: { $first: '$question' },
          updated_at: { $max: '$updated_at' }, turn_count: { $sum: 1 } } },
        { $sort: { updated_at: -1, _id: 1 } },
        { $project: { _id: 0, conversation_id: '$_id', title: { $substrCP: ['$title', 0, 80] }, updated_at: 1, turn_count: 1 } },
      ]).toArray();
    },
    async history(id, before) {
      const database = await db();
      const filter = { conversation_code: id };
      if (before) filter.$or = [
        { created_at: { $lt: new Date(before.created_at) } },
        { created_at: new Date(before.created_at), _id: { $lt: before.id } },
      ];
      return database.collection('conversation_histories').find(filter)
        .sort({ created_at: -1, _id: -1 }).limit(51).toArray();
    },
  };
}
