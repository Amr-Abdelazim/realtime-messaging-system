process.env.NODE_ENV = 'test'
process.env.DATABASE_URL = 'postgresql://messaging:messaging_dev@localhost:5432/chat_worker_test'
process.env.REDIS_URL = 'redis://localhost:6379/15'
process.env.LOG_LEVEL = 'fatal'
