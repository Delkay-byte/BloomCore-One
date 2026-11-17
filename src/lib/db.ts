import type { PrismaClient } from "@prisma/client";
import { createPrismaClient } from "./prisma-client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function client(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createPrismaClient();
  }
  return globalForPrisma.prisma;
}

/**
 * Lazily constructed Prisma client.
 *
 * `next build` imports every route module while collecting page data, and the
 * generated client is bound to one database provider. Constructing it at import
 * time made the build depend on DATABASE_URL being present *and* matching the
 * provider generated for the build. The proxy defers construction to the first
 * real query, so a build never opens a database connection and never picks a
 * driver adapter for the wrong provider.
 */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    const value = Reflect.get(client(), property, receiver) as unknown;
    return typeof value === "function" ? value.bind(client()) : value;
  },
  set(_target, property, value) {
    return Reflect.set(client(), property, value);
  },
  has(_target, property) {
    return Reflect.has(client(), property);
  },
  defineProperty(_target, property, descriptor) {
    return Reflect.defineProperty(client(), property, descriptor);
  },
  getOwnPropertyDescriptor(_target, property) {
    return Reflect.getOwnPropertyDescriptor(client(), property);
  },
  ownKeys() {
    return Reflect.ownKeys(client());
  },
});
