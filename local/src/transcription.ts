/**
 * Pluggable transcription service.
 *
 * Two backends:
 *   - "local": Shell out to parakeet-mlx (Python, macOS with Apple Silicon)
 *   - "api": Call an external transcription API (OpenAI Whisper, Deepgram, etc.)
 *
 * Configured via environment variables:
 *   TRANSCRIPTION_BACKEND=local|api  (default: local)
 *   TRANSCRIPTION_PYTHON=<path>      (default: python3)
 *   TRANSCRIPTION_MODEL=<model_id>   (default: mlx-community/parakeet-tdt-0.6b-v2)
 *   TRANSCRIPTION_API_URL=<url>      (for api backend)
 *   TRANSCRIPTION_API_KEY=<key>      (for api backend)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptionResult {
  text: string;
  duration_seconds?: number;
  backend: string;
}

export interface TranscriptionBackend {
  name: string;
  available(): Promise<boolean>;
  transcribe(audioPath: string): Promise<TranscriptionResult>;
}

// ---------------------------------------------------------------------------
// Local backend: parakeet-mlx via Python subprocess
// ---------------------------------------------------------------------------

class ParakeetLocalBackend implements TranscriptionBackend {
  name = "parakeet-mlx";
  private python: string;
  private model: string;

  constructor() {
    this.python = process.env.TRANSCRIPTION_PYTHON ?? "python3";
    this.model = process.env.TRANSCRIPTION_MODEL ?? "mlx-community/parakeet-tdt-0.6b-v2";
  }

  async available(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(this.python, ["-c", "import parakeet_mlx; print('ok')"], {
        timeout: 10000,
      });
      let out = "";
      proc.stdout?.on("data", (d) => (out += d.toString()));
      proc.on("close", (code) => resolve(code === 0 && out.includes("ok")));
      proc.on("error", () => resolve(false));
    });
  }

  async transcribe(audioPath: string): Promise<TranscriptionResult> {
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }

    // Python script that loads model, transcribes, prints JSON result
    const script = `
import json, sys
from parakeet_mlx import from_pretrained

model = from_pretrained("${this.model}")
result = model.transcribe(sys.argv[1])
print(json.dumps({"text": result.text}))
`;

    return new Promise((resolve, reject) => {
      const proc = spawn(this.python, ["-c", script, audioPath], {
        timeout: 120000, // 2 minute timeout for long audio
      });

      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (d) => (stdout += d.toString()));
      proc.stderr?.on("data", (d) => (stderr += d.toString()));

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`parakeet-mlx failed (code ${code}): ${stderr.slice(-500)}`));
          return;
        }

        try {
          // Find the last JSON line (model may print download progress to stdout)
          const lines = stdout.trim().split("\n");
          const jsonLine = lines.reverse().find((l) => l.startsWith("{"));
          if (!jsonLine) {
            reject(new Error(`No JSON output from parakeet-mlx: ${stdout.slice(-200)}`));
            return;
          }
          const result = JSON.parse(jsonLine);
          resolve({
            text: result.text ?? "",
            duration_seconds: result.duration_seconds,
            backend: this.name,
          });
        } catch (e) {
          reject(new Error(`Failed to parse parakeet-mlx output: ${e}`));
        }
      });

      proc.on("error", (e) => reject(new Error(`Failed to spawn python: ${e.message}`)));
    });
  }
}

// ---------------------------------------------------------------------------
// API backend: call an external transcription service
// ---------------------------------------------------------------------------

class ApiTranscriptionBackend implements TranscriptionBackend {
  name = "api";
  private url: string;
  private apiKey: string | undefined;

  constructor() {
    this.url = process.env.TRANSCRIPTION_API_URL ?? "";
    this.apiKey = process.env.TRANSCRIPTION_API_KEY;
  }

  async available(): Promise<boolean> {
    return this.url.length > 0;
  }

  async transcribe(audioPath: string): Promise<TranscriptionResult> {
    if (!this.url) {
      throw new Error("TRANSCRIPTION_API_URL not configured");
    }

    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }

    const audioData = fs.readFileSync(audioPath);
    const filename = path.basename(audioPath);
    const ext = path.extname(audioPath).toLowerCase();

    // Build multipart form data
    const boundary = `----parachute${Date.now()}`;
    const mimeTypes: Record<string, string> = {
      ".wav": "audio/wav",
      ".mp3": "audio/mpeg",
      ".m4a": "audio/mp4",
      ".ogg": "audio/ogg",
      ".webm": "audio/webm",
    };
    const contentType = mimeTypes[ext] ?? "application/octet-stream";

    const preamble = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
    );
    const postamble = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([preamble, audioData, postamble]);

    const headers: Record<string, string> = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Transcription API ${response.status}: ${errText.slice(0, 200)}`);
    }

    const result = (await response.json()) as any;

    // Support OpenAI Whisper API response shape ({ text: "..." })
    // and generic shapes ({ transcript: "..." } or { result: { text: "..." } })
    const text =
      result.text ??
      result.transcript ??
      result.result?.text ??
      result.results?.[0]?.transcript ??
      "";

    return {
      text,
      backend: this.name,
    };
  }
}

// ---------------------------------------------------------------------------
// Service: picks the right backend
// ---------------------------------------------------------------------------

export class TranscriptionService {
  private backends: TranscriptionBackend[] = [];
  private _available: boolean | null = null;

  constructor() {
    const preferredBackend = process.env.TRANSCRIPTION_BACKEND ?? "local";

    if (preferredBackend === "api") {
      this.backends = [new ApiTranscriptionBackend(), new ParakeetLocalBackend()];
    } else {
      this.backends = [new ParakeetLocalBackend(), new ApiTranscriptionBackend()];
    }
  }

  /** Check if any transcription backend is available. */
  async isAvailable(): Promise<boolean> {
    if (this._available !== null) return this._available;

    for (const backend of this.backends) {
      if (await backend.available()) {
        this._available = true;
        console.log(`[transcription] Backend available: ${backend.name}`);
        return true;
      }
    }
    this._available = false;
    console.log("[transcription] No backend available");
    return false;
  }

  /** Transcribe an audio file using the first available backend. */
  async transcribe(audioPath: string): Promise<TranscriptionResult> {
    for (const backend of this.backends) {
      if (await backend.available()) {
        console.log(`[transcription] Using ${backend.name} for ${path.basename(audioPath)}`);
        return backend.transcribe(audioPath);
      }
    }
    throw new Error("No transcription backend available");
  }
}
