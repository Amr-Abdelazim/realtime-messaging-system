process.env.NODE_ENV = 'test'
process.env.PORT = '3001'

process.env.DATABASE_URL = 'postgresql://messaging:messaging_dev@localhost:5432/chat_test'

process.env.DATABASE_URL_TEST = 'postgresql://messaging:messaging_dev@localhost:5432/chat_test'

process.env.REDIS_URL = 'redis://localhost:6379'

process.env.LOG_LEVEL = 'fatal'
process.env.CORS_ORIGINS = 'http://localhost:5173'
