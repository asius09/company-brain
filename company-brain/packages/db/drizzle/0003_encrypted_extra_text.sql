ALTER TABLE "ai_provider_configs" ALTER COLUMN "encrypted_extra" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ALTER COLUMN "encrypted_extra" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "ai_provider_configs" ALTER COLUMN "encrypted_extra" DROP NOT NULL;