import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(), email: text().notNull().unique(), passwordHash: text('password_hash').notNull(),
  role: text().notNull().default('user'), createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
export const providers = pgTable('providers', {
  id: uuid().primaryKey().defaultRandom(), ownerId: uuid('owner_id').notNull().references(() => users.id),
  name: text().notNull(), kind: text().notNull(), config: jsonb().notNull(), secret: text().notNull(),
});
