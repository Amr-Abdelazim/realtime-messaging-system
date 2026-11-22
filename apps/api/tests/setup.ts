process.env.NODE_ENV = 'test'
process.env.PORT = '3001'
process.env.TRUST_PROXY = '0'

process.env.DATABASE_URL = 'postgresql://messaging:messaging_dev@localhost:5432/chat_test'

process.env.DATABASE_URL_TEST = 'postgresql://messaging:messaging_dev@localhost:5432/chat_test'

process.env.REDIS_URL = 'redis://localhost:6379'
process.env.JWT_ACCESS_SECRET = 'test-only-access-secret-with-at-least-32-chars'
process.env.JWT_ACCESS_TTL_SECONDS = '900'
process.env.REFRESH_TTL_DAYS = '30'
process.env.COOKIE_SECURE = 'false'

process.env.LOG_LEVEL = 'fatal'
process.env.CORS_ORIGINS = 'http://localhost:5173'
