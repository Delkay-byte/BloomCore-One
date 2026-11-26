/** One-off diagnostic: can the existing SQLite-generated Prisma client use the pg driver adapter? */
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.DATABASE_URL;
const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
try {
  const rows = await client.$queryRaw`SELECT 1 AS ok`;
  console.log(JSON.stringify(rows));
} catch (error) {
  console.error("ERR", error.message);
  process.exitCode = 1;
} finally {
  await client.$disconnect();
}
