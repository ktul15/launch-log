import { FastifyRequest, FastifyReply } from 'fastify'
import { ALLOWED_ROLES } from '../config/constants'

export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    req.user = await req.accessVerify()
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    // @fastify/jwt wraps header-path expiry as FST_JWT_AUTHORIZATION_TOKEN_EXPIRED;
    // cookie-path (and instance-level) expiry surfaces as FAST_JWT_EXPIRED from fast-jwt.
    if (
      code === 'FST_JWT_AUTHORIZATION_TOKEN_EXPIRED' ||
      code === 'FAST_JWT_EXPIRED'
    ) {
      return reply.status(401).send({ message: 'Token expired', code: 'TOKEN_EXPIRED' })
    }
    return reply.status(401).send({ message: 'Unauthorized' })
  }

  const { sub, orgId, role } = req.user
  if (
    typeof sub !== 'string' || !sub ||
    typeof orgId !== 'string' || !orgId ||
    !ALLOWED_ROLES.includes(role)
  ) {
    return reply.status(401).send({ message: 'Unauthorized' })
  }
}
