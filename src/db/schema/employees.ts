import { pgEnum, pgTable, varchar } from "drizzle-orm/pg-core";
import { baseColumns } from "./base";

export const employeeRole = pgEnum("employee_role", ["ADMIN", "MANAGER", "MEMBER"]);

export const employees = pgTable("employees", {
  ...baseColumns(),
  // Organisation email; stored lowercased so uniqueness is case-insensitive
  emailId: varchar("email_id", { length: 255 }).notNull().unique("employees_email_id_unique"),
  name: varchar("name", { length: 150 }).notNull(),
  role: employeeRole("role").notNull().default("MEMBER"),
  // Google account `sub`, bound on first login; later logins must present the same one
  googleSub: varchar("google_sub", { length: 255 }).unique("employees_google_sub_unique"),
});

export type Employee = typeof employees.$inferSelect;
export type NewEmployee = typeof employees.$inferInsert;
export type EmployeeRole = (typeof employeeRole.enumValues)[number];
