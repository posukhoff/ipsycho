import { defineScreen } from "../../app/routes.js";
import { ProfileScreen } from "./profile-screen.js";

export const screens = [defineScreen("profile", ProfileScreen)];
