import { startConsole } from "./startup-recovery";

// Keep the recovery entry independent of React, authentication and routing.
// The initial performance budget still includes the complete runtime shell.
void startConsole(() => import("../../main"));
