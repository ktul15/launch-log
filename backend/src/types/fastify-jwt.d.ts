// Global type augmentations for @fastify/jwt and Fastify.
// Kept in a dedicated ambient file so they are unconditionally included by the compiler
// for all files in src/, regardless of import order.
// export {} makes this file a module so declare module blocks merge with (not replace) the originals.
export {}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: { sub: string; orgId: string; role: 'owner' | 'editor' }
  }
}

// req.accessVerify is decorated at runtime by @fastify/jwt via `jwtVerify: 'accessVerify'` in
// src/plugins/jwt.ts. If that option is ever removed or renamed, the TypeScript declaration here
// will still compile — verify the plugin config matches this name when changing jwt.ts.
declare module 'fastify' {
  interface FastifyRequest {
    accessVerify<T = { sub: string; orgId: string; role: 'owner' | 'editor' }>(): Promise<T>
  }
}
