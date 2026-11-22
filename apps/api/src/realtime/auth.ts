import { TokenExpiredError, UnauthenticatedError } from '../http/errors/index.js'
import { logger } from '../infra/logger.js'
import { authenticateAccessToken } from '../modules/auth/access.js'
import type { AccessTokenContext } from '../modules/auth/access.js'
import type { RealtimeServer } from './types.js'

export function installSocketAuth(
  io: RealtimeServer,
  authenticate: (token: string) => Promise<AccessTokenContext> = authenticateAccessToken,
): void {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token
    if (typeof token !== 'string' || token.length === 0) {
      next(new Error('UNAUTHENTICATED'))
      return
    }

    try {
      Object.assign(socket.data, await authenticate(token))
      next()
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        next(new Error('TOKEN_EXPIRED'))
        return
      }
      if (error instanceof UnauthenticatedError) {
        next(new Error('UNAUTHENTICATED'))
        return
      }

      logger.error({ err: error }, 'Unexpected socket authentication error')
      next(new Error('INTERNAL'))
    }
  })
}
