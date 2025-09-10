import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  // örnek kullanıcı yoksa oluştur (dev amaçlı)
  const email = "dev@imgus.local";
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: { email, name: "Dev User" },
    });
  }

  // wallet yoksa aç
  await prisma.wallet.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id, currency: "TRY" },
  });

  // signup bonusu daha önce verilmemişse ekle
  const already = await prisma.creditLog.findFirst({
    where: { userId: user.id, reason: "signup_bonus" },
  });
  if (!already) {
    await prisma.creditLog.create({
      data: {
        userId: user.id,
        delta: 50, // örnek: 50 kredi
        reason: "signup_bonus",
        refType: "system",
        refId: "seed",
      },
    });
  }

  console.log("Seed completed for", email);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });