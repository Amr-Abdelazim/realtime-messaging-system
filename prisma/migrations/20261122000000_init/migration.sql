CREATE TYPE "ConversationType" AS ENUM ('DIRECT', 'GROUP');
CREATE TYPE "ParticipantRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'SYSTEM');

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_displayName_idx" ON "User"("displayName");

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_familyId_idx" ON "Session"("familyId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "type" "ConversationType" NOT NULL,
    "name" TEXT,
    "directKey" TEXT,
    "createdById" TEXT,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "lastMessageId" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Conversation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Conversation_directKey_key" ON "Conversation"("directKey");
CREATE UNIQUE INDEX "Conversation_lastMessageId_key" ON "Conversation"("lastMessageId");
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt" DESC);

CREATE TABLE "Participant" (
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ParticipantRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),
    "lastDeliveredSeq" INTEGER NOT NULL DEFAULT 0,
    "lastReadSeq" INTEGER NOT NULL DEFAULT 0,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "joinedAtSeq" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Participant_pkey" PRIMARY KEY ("conversationId", "userId"),
    CONSTRAINT "Participant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Participant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Participant_userId_leftAt_idx" ON "Participant"("userId", "leftAt");

CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "senderId" TEXT,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "content" VARCHAR(4000) NOT NULL,
    "clientMessageId" TEXT NOT NULL,
    "replyToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "Message_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Message_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Message_conversationId_seq_key" ON "Message"("conversationId", "seq");
CREATE UNIQUE INDEX "Message_senderId_clientMessageId_key" ON "Message"("senderId", "clientMessageId");
CREATE INDEX "Message_conversationId_seq_idx" ON "Message"("conversationId", "seq" DESC);

ALTER TABLE "Conversation"
ADD CONSTRAINT "Conversation_lastMessageId_fkey"
FOREIGN KEY ("lastMessageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
