import test from "node:test";
import assert from "node:assert/strict";
import "reflect-metadata";
import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { ActionsModule } from "../../dist/actions/actions.module.js";
import { SettingsModule } from "../../dist/settings/settings.module.js";

test("ActionsModule imports the module that provides SettingsService", () => {
  const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, ActionsModule) ?? [];
  assert.ok(imports.includes(SettingsModule));
});
