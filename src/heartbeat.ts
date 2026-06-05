import * as vscode from "vscode";
import { log } from "./log";
import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { StatusBarManager } from "./status-bar";
import { getApiKey, getBaseUrl } from "./config";

interface Heartbeat {
  timestamp: string;
  ide: string;
  os: string;
  project: string;
  language: string;
  file: string;
  duration_seconds: number;
}

export class HeartbeatManager {
  private lastHeartbeat: number = 0;
  private lastFile: string = "";
  private heartbeatInterval: number = 120000;
  private userInactivityThresholdMilliseconds: number = 15 * 60 * 1000;
  private activeDocumentInfo: { file: string; language: string } | null = null;
  private statusBar: StatusBarManager | null = null;
  private heartbeatCount: number = 0;
  private successCount: number = 0;
  private failureCount: number = 0;
  private offlineHeartbeats: Heartbeat[] = [];
  private offlineQueuePath: string;
  private isOnline: boolean = true;
  private hasValidApiKey: boolean = true;
  private lastActivity: number = Date.now();
  private todayLocalTotalSeconds: number = 0;
  private currentDay: string = new Date().toDateString();
  private isWindowFocused: boolean = true;
  private unsyncedLocalSeconds: number = 0;
  private activeSecondsSinceLastHeartbeat: number = 0;
  private activityAccumulatorIntervalId: NodeJS.Timeout | null = null;
  private lastTimeAccumulated: number = Date.now();

  constructor(
    private context: vscode.ExtensionContext,
    statusBar?: StatusBarManager,
  ) {
    this.statusBar = statusBar || null;

    const xdgConfigHome = process.env.XDG_CONFIG_HOME;
    const configDir = xdgConfigHome
      ? path.join(xdgConfigHome, "epoch")
      : path.join(os.homedir(), ".config", "epoch");

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    this.offlineQueuePath = path.join(configDir, "offline_heartbeats.json");
    this.migrateOfflineHeartbeats();
    this.loadOfflineHeartbeats();
    this.initialize();
  }

  private initialize(): void {
    this.isWindowFocused = vscode.window.state.focused;
    this.lastActivity = Date.now();
    this.lastTimeAccumulated = Date.now();

    this.activityAccumulatorIntervalId = setInterval(() => {
      const now = Date.now();
      this.rolloverDayIfNeeded();
      if (this.isWindowFocused) {
        const timeSinceLastInteraction = now - this.lastActivity;
        if (
          timeSinceLastInteraction < this.userInactivityThresholdMilliseconds
        ) {
          const elapsedSeconds = Math.floor(
            (now - this.lastTimeAccumulated) / 1000,
          );
          if (elapsedSeconds > 0) {
            this.unsyncedLocalSeconds += elapsedSeconds;
            this.activeSecondsSinceLastHeartbeat += elapsedSeconds;
            this.todayLocalTotalSeconds += elapsedSeconds;
            this.refreshStatusBarTime();
          }
        }
      }
      this.lastTimeAccumulated = now;
    }, 5000);

    this.context.subscriptions.push({
      dispose: () => {
        if (this.activityAccumulatorIntervalId) {
          clearInterval(this.activityAccumulatorIntervalId);
        }
      },
    });

    this.registerEventListeners();
    this.scheduleHeartbeat();
    this.syncOfflineHeartbeats();

    if (this.statusBar) {
      this.statusBar.setOnlineStatus(this.isOnline);
      this.statusBar.setApiKeyStatus(this.hasValidApiKey);
      if (this.isWindowFocused) {
        this.statusBar.startTracking();
      }
    }
  }

  private registerEventListeners(): void {
    log("Registering event listeners for editor changes");

    vscode.window.onDidChangeActiveTextEditor(
      this.handleActiveEditorChange,
      null,
      this.context.subscriptions,
    );

    vscode.workspace.onDidChangeTextDocument(
      this.handleDocumentChange,
      null,
      this.context.subscriptions,
    );

    vscode.workspace.onDidSaveTextDocument(
      this.handleDocumentSave,
      null,
      this.context.subscriptions,
    );

    vscode.window.onDidChangeWindowState(
      this.handleWindowStateChange,
      null,
      this.context.subscriptions,
    );

    if (vscode.window.activeTextEditor) {
      this.handleActiveEditorChange(vscode.window.activeTextEditor);
    }
  }

  private recordUserInteraction(): void {
    this.lastActivity = Date.now();
    if (this.statusBar && this.isWindowFocused) {
      this.statusBar.startTracking();
    }
  }

  private handleActiveEditorChange = (
    editor: vscode.TextEditor | undefined,
  ): void => {
    if (editor) {
      log(
        `Editor changed: ${editor.document.uri.fsPath} (${editor.document.languageId})`,
      );
      this.activeDocumentInfo = {
        file: path.basename(editor.document.uri.fsPath),
        language: editor.document.languageId,
      };
      this.recordUserInteraction();
      this.sendHeartbeat(true);
    }
  };

  private handleDocumentChange = (
    event: vscode.TextDocumentChangeEvent,
  ): void => {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document === event.document) {
      this.activeDocumentInfo = {
        file: path.basename(event.document.uri.fsPath),
        language: event.document.languageId,
      };
      this.recordUserInteraction();
      const now = Date.now();
      const fileChanged = this.lastFile !== event.document.uri.fsPath;
      const timeThresholdPassed =
        now - this.lastHeartbeat >= this.heartbeatInterval;
      if (fileChanged || timeThresholdPassed) {
        this.sendHeartbeat();
      }
    }
  };

  private handleDocumentSave = (document: vscode.TextDocument): void => {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document === document) {
      this.recordUserInteraction();
      this.sendHeartbeat(true);
    }
  };

  private handleWindowStateChange = (windowState: vscode.WindowState): void => {
    const wasFocused = this.isWindowFocused;
    this.isWindowFocused = windowState.focused;
    log(`Window focus state changed: ${wasFocused} -> ${this.isWindowFocused}`);
    if (!this.isWindowFocused && wasFocused) {
      if (this.statusBar) {
        this.statusBar.stopTracking();
      }
    } else if (this.isWindowFocused && !wasFocused) {
      this.lastActivity = Date.now();
      log(
        `Window focused, activity timer reset at ${new Date(
          this.lastActivity,
        ).toLocaleTimeString()}`,
      );
      if (this.statusBar) {
        this.statusBar.startTracking();
      }
    }
  };

  private scheduleHeartbeat(): void {
    log(
      `Setting up heartbeat schedule with interval: ${this.heartbeatInterval}ms and inactivity threshold: ${this.userInactivityThresholdMilliseconds}ms`,
    );
    setInterval(() => {
      const now = Date.now();
      const userIsEffectivelyActive =
        this.isWindowFocused &&
        now - this.lastActivity < this.userInactivityThresholdMilliseconds;
      if (this.activeDocumentInfo && userIsEffectivelyActive) {
        this.sendHeartbeat();
        if (this.statusBar && this.isWindowFocused) {
          this.statusBar.startTracking();
        }
      } else {
        const reason = !this.activeDocumentInfo
          ? "no active document"
          : !this.isWindowFocused
            ? "window not focused"
            : "user inactive";
        log(
          `Skipping heartbeat (${reason}). Focused: ${
            this.isWindowFocused
          }, SufficientlyRecentInteraction: ${
            now - this.lastActivity < this.userInactivityThresholdMilliseconds
          }, ActiveDoc: ${!!this.activeDocumentInfo}`,
        );
        if (this.statusBar) {
          this.statusBar.stopTracking();
        }
      }
    }, this.heartbeatInterval);
    setInterval(
      () => {
        log(
          `Heartbeat stats - Total: ${this.heartbeatCount}, Success: ${this.successCount}, Failed: ${this.failureCount}, Offline: ${this.offlineHeartbeats.length}`,
        );
      },
      15 * 60 * 1000,
    );
  }

  private migrateOfflineHeartbeats(): void {
    try {
      const legacyOfflinePath = path.join(
        os.homedir(),
        ".epoch",
        "offline_heartbeats.json",
      );

      if (
        fs.existsSync(legacyOfflinePath) &&
        !fs.existsSync(this.offlineQueuePath)
      ) {
        const legacyData = fs.readFileSync(legacyOfflinePath, "utf8");
        fs.writeFileSync(this.offlineQueuePath, legacyData, "utf8");
        fs.unlinkSync(legacyOfflinePath);
        log(
          `Migrated offline heartbeats from ${legacyOfflinePath} to ${this.offlineQueuePath}`,
        );

        try {
          const legacyDir = path.dirname(legacyOfflinePath);
          const dirContents = fs.readdirSync(legacyDir);
          if (dirContents.length === 0) {
            fs.rmdirSync(legacyDir);
            log(`Removed empty legacy directory: ${legacyDir}`);
          }
        } catch (cleanupError) {
          log(
            `Could not remove legacy directory: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
      }
    } catch (error) {
      log(
        `Error migrating offline heartbeats: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // API keys are scoped to sending heartbeats only; they cannot read the
  // dashboard stats endpoint (that is JWT/session-only). The status-bar time is
  // therefore derived purely from locally tracked active time, and the API key
  // status is driven solely by the heartbeat endpoint's response.
  private rolloverDayIfNeeded(): void {
    const today = new Date().toDateString();
    if (today !== this.currentDay) {
      this.currentDay = today;
      this.todayLocalTotalSeconds = 0;
      this.unsyncedLocalSeconds = 0;
      this.refreshStatusBarTime();
    }
  }

  private refreshStatusBarTime(): void {
    if (!this.statusBar) {
      return;
    }
    const total = this.todayLocalTotalSeconds;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    this.statusBar.updateTime(hours, minutes);
  }

  private async syncOfflineHeartbeats(): Promise<void> {
    log(
      "Syncing offline heartbeats to the connected epoch instance: " +
        (await getBaseUrl()),
    );

    if (!this.isOnline || this.offlineHeartbeats.length === 0) return;
    const apiKey = await getApiKey();
    const baseUrl = await getBaseUrl();
    if (!apiKey || !baseUrl) {
      return;
    }

    this.offlineHeartbeats = this.offlineHeartbeats.map((heartbeat) => ({
      ...heartbeat,
      timestamp:
        typeof heartbeat.timestamp === "number"
          ? new Date(heartbeat.timestamp).toISOString()
          : heartbeat.timestamp,
    }));

    // The API exposes no batch endpoint, so flush the queue one heartbeat at a
    // time through the regular heartbeat endpoint.
    while (this.offlineHeartbeats.length > 0) {
      const heartbeat = this.offlineHeartbeats[0];

      try {
        await this.postHeartbeat(heartbeat, apiKey, baseUrl);
        this.offlineHeartbeats.shift();
        this.saveOfflineHeartbeats();
        this.setApiKeyStatus(true);
      } catch (error) {
        log(
          `Error syncing offline heartbeat: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        if (error instanceof Error && error.message.includes("API key")) {
          this.setApiKeyStatus(false);
        } else {
          this.setOnlineStatus(false);
        }
        break;
      }
    }

    if (this.offlineHeartbeats.length === 0) {
      this.unsyncedLocalSeconds = 0;
      this.refreshStatusBarTime();
    }
  }

  private async sendHeartbeat(force: boolean = false): Promise<void> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || !this.activeDocumentInfo) return;
    const now = Date.now();
    const fileChanged = this.lastFile !== activeEditor.document.uri.fsPath;
    const timeThresholdPassed =
      now - this.lastHeartbeat >= this.heartbeatInterval;
    if (!force && !fileChanged && !timeThresholdPassed) {
      return;
    }
    this.lastFile = activeEditor.document.uri.fsPath;
    this.lastHeartbeat = now;
    this.heartbeatCount++;
    const project = await this.getProjectName(activeEditor.document.uri);
    if (!project) {
      log("No project name found for the current file, skipping heartbeat");
      return;
    }
    const apiKey = await getApiKey();
    const baseUrl = await getBaseUrl();
    if (!apiKey || !baseUrl) {
      return;
    }
    const durationSeconds = this.activeSecondsSinceLastHeartbeat;
    this.activeSecondsSinceLastHeartbeat = 0;
    if (durationSeconds <= 0) {
      log("Skipping heartbeat: no active seconds accumulated (duration_seconds = 0)");
      return;
    }
    const heartbeat: Heartbeat = {
      timestamp: new Date().toISOString(),
      ide: vscode.env.appName,
      os:
        process.platform === "win32"
          ? "Windows"
          : process.platform === "darwin"
            ? "macOS"
            : "Linux",
      project,
      language: this.activeDocumentInfo.language,
      file: this.activeDocumentInfo.file,
      duration_seconds: durationSeconds,
    };
    if (!this.isOnline) {
      this.offlineHeartbeats.push(heartbeat);
      this.saveOfflineHeartbeats();
      return;
    }
    try {
      await this.postHeartbeat(heartbeat, apiKey, baseUrl);
      this.successCount++;
      this.setOnlineStatus(true);
      this.setApiKeyStatus(true);
      this.unsyncedLocalSeconds = 0;
      log(
        `Heartbeat sent successfully for ${heartbeat.file} (${heartbeat.language}) in project ${heartbeat.project}`,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("API key")) {
        this.setApiKeyStatus(false);
      } else {
        this.failureCount++;
        this.setOnlineStatus(false);
      }
      this.offlineHeartbeats.push(heartbeat);
      this.saveOfflineHeartbeats();
      log(
        `Failed to send heartbeat: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private postHeartbeat(
    heartbeat: Heartbeat,
    apiKey: string,
    baseUrl: string,
  ): Promise<void> {
    const data = JSON.stringify(heartbeat);
    const url = new URL("/api/v1/heartbeat", baseUrl);
    const requestOptions = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        Authorization: `Bearer ${apiKey}`,
      },
      protocol: url.protocol,
    };
    return new Promise<void>((resolve, reject) => {
      const req = (url.protocol === "https:" ? https : http).request(
        requestOptions,
        (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else if (res.statusCode === 401) {
            reject(
              new Error(`Invalid API key (status code: ${res.statusCode})`),
            );
          } else {
            reject(new Error(`Failed with status code: ${res.statusCode}`));
          }
        },
      );
      req.on("error", (err) => {
        reject(err);
      });
      req.write(data);
      req.end();
    });
  }

  private loadOfflineHeartbeats(): void {
    try {
      if (fs.existsSync(this.offlineQueuePath)) {
        const data = fs.readFileSync(this.offlineQueuePath, "utf8");
        const loaded: Heartbeat[] = JSON.parse(data);
        this.offlineHeartbeats = loaded.filter((h) => h.duration_seconds > 0);
      }
    } catch (error) {
      log(
        `Error loading offline heartbeats: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.offlineHeartbeats = [];
    }
  }

  private saveOfflineHeartbeats(): void {
    try {
      fs.writeFileSync(
        this.offlineQueuePath,
        JSON.stringify(this.offlineHeartbeats),
        "utf8",
      );
    } catch (error) {
      log(
        `Error saving offline heartbeats: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async getProjectName(
    fileUri: vscode.Uri,
  ): Promise<string | undefined> {
    try {
      const gitExtension = vscode.extensions.getExtension<{
        getAPI(version: number): any;
      }>("vscode.git");
      if (!gitExtension) {
        log("Git extension not found.");
        return this.getProjectNameFromWorkspaceFolder(fileUri);
      }

      if (!gitExtension.isActive) {
        await gitExtension.activate();
        log("Git extension activated.");
      }

      const git = gitExtension.exports.getAPI(1);
      if (!git) {
        log("Git API not available.");
        return this.getProjectNameFromWorkspaceFolder(fileUri);
      }

      const repository = git.getRepository(fileUri);
      if (!repository) {
        log(`No Git repository found containing the file: ${fileUri.fsPath}`);
        return this.getProjectNameFromWorkspaceFolder(fileUri);
      }

      log(
        `Found repository for file ${fileUri.fsPath}: ${repository.rootUri.fsPath}`,
      );
      const remotes = repository.state.remotes;

      const getProjectNameFromUrl = (url: string): string | undefined => {
        try {
          const lastSeparator = Math.max(
            url.lastIndexOf("/"),
            url.lastIndexOf(":"),
          );
          if (lastSeparator === -1) return undefined;
          let name = url.substring(lastSeparator + 1);
          if (name.endsWith(".git")) name = name.slice(0, -4);
          return name || undefined;
        } catch (e) {
          log(`Error parsing git remote URL ${url}: ${e}`);
          return undefined;
        }
      };

      const getProjectNameFromLocalPath = (repo: any): string | undefined => {
        const repoPath = repo?.rootUri?.fsPath;
        if (repoPath) {
          let name = path.basename(repoPath);
          if (name.endsWith(".git")) name = name.slice(0, -4);
          return name || undefined;
        }
        return undefined;
      };

      if (remotes.length > 0) {
        const originRemote = remotes.find(
          (remote: any) => remote.name === "origin",
        );
        const remoteToUse = originRemote || remotes[0];
        const remoteUrl = remoteToUse.fetchUrl || remoteToUse.pushUrl;
        if (remoteUrl) {
          const projectName = getProjectNameFromUrl(remoteUrl);
          if (projectName) return projectName;
        }
      }

      const localProjectName = getProjectNameFromLocalPath(repository);
      if (localProjectName) return localProjectName;

      return undefined;
    } catch (error) {
      log(
        `Error getting project name from Git: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.getProjectNameFromWorkspaceFolder(fileUri);
    }
  }

  private getProjectNameFromWorkspaceFolder(
    fileUri: vscode.Uri,
  ): string | undefined {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
    log(
      `Falling back to workspace folder name for ${fileUri.fsPath}. Found: ${workspaceFolder?.name}`,
    );
    return workspaceFolder?.name;
  }

  private setOnlineStatus(isOnline: boolean): void {
    if (this.isOnline !== isOnline) {
      this.isOnline = isOnline;
      if (this.statusBar) {
        this.statusBar.setOnlineStatus(isOnline);
      }
      log(`Online status changed to: ${isOnline ? "online" : "offline"}`);
      this.syncOfflineHeartbeats();
    }
  }

  private setApiKeyStatus(isValid: boolean): void {
    if (this.hasValidApiKey !== isValid) {
      this.hasValidApiKey = isValid;
      if (this.statusBar) {
        this.statusBar.setApiKeyStatus(isValid);
      }
      log(`API key status changed to: ${isValid ? "valid" : "invalid"}`);
    }
  }

  public dispose(): void {
    this.saveOfflineHeartbeats();
    if (this.activityAccumulatorIntervalId) {
      clearInterval(this.activityAccumulatorIntervalId);
      this.activityAccumulatorIntervalId = null;
    }
  }
}
