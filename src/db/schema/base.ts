import { boolean, timestamp, uuid } from "drizzle-orm/pg-core";

// Columns shared by every table. Call it per table so each gets fresh column builders:
//   pgTable("things", { ...baseColumns(), name: text("name") })
export function baseColumns() {
  return {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    isActive: boolean("is_active").notNull().default(true),
  };
}
