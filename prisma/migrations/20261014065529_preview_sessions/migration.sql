-- CreateTable
CREATE TABLE "PreviewSession" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "projectId" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreviewSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreviewAttempt" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "projectId" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "maxScore" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreviewAttempt_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "PreviewAttempt" ADD CONSTRAINT "PreviewAttempt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "PreviewSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
