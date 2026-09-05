import { defineScreen } from "../../app/index.js";
import { ProfileScreen } from "./profile-screen.js";

export const screens = [defineScreen("profile", ProfileScreen)];
