-- Hand-edited: add the column nullable, backfill existing invites from the email's local part, then enforce NOT NULL
ALTER TABLE "employee_invites" ADD COLUMN "name" varchar(150);--> statement-breakpoint
UPDATE "employee_invites" SET "name" = split_part("email_id", '@', 1) WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "employee_invites" ALTER COLUMN "name" SET NOT NULL;
