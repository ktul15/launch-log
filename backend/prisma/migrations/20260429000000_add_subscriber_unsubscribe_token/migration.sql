-- AlterTable
ALTER TABLE "subscribers" ADD COLUMN "unsubscribeToken" TEXT NOT NULL DEFAULT gen_random_uuid()::text;

-- CreateIndex
CREATE UNIQUE INDEX "subscribers_unsubscribeToken_key" ON "subscribers"("unsubscribeToken");

-- CreateIndex
CREATE INDEX "subscribers_unsubscribeToken_idx" ON "subscribers"("unsubscribeToken");
