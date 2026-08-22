import "dotenv/config";
import { AccessService } from "./access/access.service.js";
import { loadConfig } from "./config.js";
import { DatabaseService } from "./database/database.service.js";

const [command, rawId] = process.argv.slice(2);
const telegramUserId = Number(rawId);
if (!command || !Number.isSafeInteger(telegramUserId)) {
  console.error("Usage: npm run admin -- <users:add|users:disable|users:restore|ai:suspend|ai:enable> <telegram_user_id>");
  process.exit(2);
}

const database = new DatabaseService(loadConfig());
const access = new AccessService(database);
try {
  if (command === "users:add") console.log(await access.addUser(telegramUserId));
  else if (command === "users:disable") await access.setUserStatus(telegramUserId, "disabled");
  else if (command === "users:restore") await access.setUserStatus(telegramUserId, "active");
  else if (command === "ai:suspend") await access.setAiStatus(telegramUserId, "suspended");
  else if (command === "ai:enable") await access.setAiStatus(telegramUserId, "enabled");
  else throw new Error(`unknown command: ${command}`);
} finally {
  await database.onApplicationShutdown();
}
