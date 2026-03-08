/**
 * Startup diagnostics — check ffmpeg, silk-wasm, data directory
 */

import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkSilkWasmAvailable } from './audio-convert';

export interface DiagnosticReport {
  platform: string;
  arch: string;
  nodeVersion: string;
  homeDir: string;
  tempDir: string;
  ffmpeg: string | null;
  silkWasm: boolean;
  warnings: string[];
}

async function detectFfmpegForDiag(): Promise<string | null> {
  try {
    const { execFile } = await import('node:child_process');
    const envPath = process.env.FFMPEG_PATH;
    if (envPath) {
      const ok = await new Promise<boolean>(resolve => {
        execFile(envPath, ['-version'], { timeout: 5000 }, err => resolve(!err));
      });
      if (ok) return envPath;
    }
    const cmd = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const ok = await new Promise<boolean>(resolve => {
      execFile(cmd, ['-version'], { timeout: 5000 }, err => resolve(!err));
    });
    return ok ? cmd : null;
  } catch {
    return null;
  }
}

export async function runDiagnostics(
  log?: { info: (msg: string) => void; warn?: (msg: string) => void },
): Promise<DiagnosticReport> {
  const warnings: string[] = [];
  const homeDir = os.homedir();
  const tempDir = os.tmpdir();
  const platform = `${process.platform} (${os.release()})`;
  const arch = process.arch;
  const nodeVersion = process.version;

  const ffmpegPath = await detectFfmpegForDiag();
  if (!ffmpegPath) {
    const hint = process.platform === 'win32'
      ? 'choco install ffmpeg / scoop install ffmpeg / https://ffmpeg.org'
      : process.platform === 'darwin'
        ? 'brew install ffmpeg'
        : 'sudo apt install ffmpeg';
    warnings.push(`ffmpeg not installed. Voice/video conversion limited. Install: ${hint}`);
  }

  const silkWasm = checkSilkWasmAvailable();
  if (!silkWasm) {
    warnings.push('silk-wasm unavailable. QQ voice messages will not work. Ensure Node.js >= 16 with WASM support.');
  }

  try {
    const testFile = path.join(tempDir, '.qqbot-write-test');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
  } catch {
    warnings.push(`Temp directory not writable: ${tempDir}`);
  }

  if (process.platform === 'win32') {
    if (/[\u4e00-\u9fa5]/.test(homeDir) || homeDir.includes(' ')) {
      warnings.push(`Home directory contains CJK chars or spaces: ${homeDir}. Some tools may malfunction.`);
    }
  }

  const report: DiagnosticReport = {
    platform, arch, nodeVersion, homeDir, tempDir, ffmpeg: ffmpegPath, silkWasm, warnings,
  };

  if (log) {
    log.info(`=== QQBot Diagnostics ===`);
    log.info(`  Platform: ${platform} (${arch}), Node: ${nodeVersion}`);
    log.info(`  ffmpeg: ${ffmpegPath ?? 'not installed'}`);
    log.info(`  silk-wasm: ${silkWasm ? 'available' : 'unavailable'}`);
    for (const w of warnings) {
      (log.warn ?? log.info)(`  WARNING: ${w}`);
    }
  }

  return report;
}
