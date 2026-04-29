-- Fix 1: Drop redundant non-unique index (unique constraint already covers lookups)
DROP INDEX IF EXISTS "subscribers_unsubscribeToken_idx";

-- Fix 2: Subscriber soft delete
ALTER TABLE "subscribers" ADD COLUMN "unsubscribedAt" TIMESTAMP WITHOUT TIME ZONE;

-- Fix 3: Voter unsubscribe
ALTER TABLE "votes" ADD COLUMN "unsubscribeToken" TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "votes" ADD COLUMN "notifyOnStatusChange" BOOLEAN NOT NULL DEFAULT true;
CREATE UNIQUE INDEX "votes_unsubscribeToken_key" ON "votes"("unsubscribeToken");
