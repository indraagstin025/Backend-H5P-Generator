-- AlterTable
ALTER TABLE "User" ADD COLUMN     "birthDate" DATE,
ADD COLUMN     "profileCompleted" BOOLEAN NOT NULL DEFAULT true;
