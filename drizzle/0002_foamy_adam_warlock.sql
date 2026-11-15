ALTER TABLE "collection_lots" ALTER COLUMN "status" SET DATA TYPE varchar(32);--> statement-breakpoint
ALTER TABLE "collection_lots" ALTER COLUMN "status" SET DEFAULT 'draft';