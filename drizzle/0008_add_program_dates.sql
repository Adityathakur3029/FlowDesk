ALTER TABLE "programs" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "end_date" date;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_date_range_check" CHECK ("programs"."end_date" IS NULL OR "programs"."start_date" IS NULL OR "programs"."end_date" >= "programs"."start_date");