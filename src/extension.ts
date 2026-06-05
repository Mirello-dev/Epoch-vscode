import * as vscode from "vscode";
import { log, showOutputChannel } from "./log";
import { HeartbeatManager } from "./heartbeat";
import { StatusBarManager } from "./status-bar";
import {
  setApiKey,
  setBaseUrl,
  validateApiKey,
  initializeAndSyncConfig,
} from "./config";

export async function activate(context: vscode.ExtensionContext) {
  await initializeAndSyncConfig();

  log("epoch extension activated");

  const statusBarManager = new StatusBarManager();
  context.subscriptions.push(statusBarManager);

  const heartbeatManager = new HeartbeatManager(context, statusBarManager);
  context.subscriptions.push(heartbeatManager);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("epoch.apiKey")) {
        log("API key changed in settings, validating...");
      }
    })
  );

  const openDashboardCommand = vscode.commands.registerCommand(
    "epoch.openDashboard",
    async () => {
      const config = vscode.workspace.getConfiguration("epoch");
      const baseUrl = config.get<string>("baseUrl");
      if (baseUrl) {
        vscode.env.openExternal(vscode.Uri.parse(`${baseUrl}/`));
      } else {
        vscode.window.showErrorMessage("No base URL configured for epoch");
      }
    }
  );

  const setApiKeyCommand = vscode.commands.registerCommand(
    "epoch.setApiKey",
    async () => {
      await setApiKey();
    }
  );

  const setBaseUrlCommand = vscode.commands.registerCommand(
    "epoch.setBaseUrl",
    async () => {
      await setBaseUrl();
    }
  );

  const validateApiKeyCommand = vscode.commands.registerCommand(
    "epoch.validateApiKey",
    async () => {
      await validateApiKey();
    }
  );

  const showOutputCommand = vscode.commands.registerCommand(
    "epoch.showOutput",
    () => {
      showOutputChannel();
    }
  );

  context.subscriptions.push(
    openDashboardCommand,
    setApiKeyCommand,
    setBaseUrlCommand,
    validateApiKeyCommand,
    showOutputCommand
  );
}

export function deactivate() {
  log("epoch extension deactivated");
}
