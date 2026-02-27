/**
 * Windows ARM64 ffmpeg/ffprobe binary resolver.
 *
 * Downloads a pre-built ARM64 ffmpeg/ffprobe zip from GitHub on first use
 * and caches the extracted binaries under <userData>/ffmpeg-arm64/.
 *
 * On non-Windows-ARM64 platforms every function is a no-op returning null.
 */

import { app } from 'electron'
import { join } from 'path'
import { access, mkdir, rename, rm, mkdtemp, copyFile } from 'fs/promises'
import { createWriteStream } from 'fs'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import https from 'https'
import http from 'http'

const FFMPEG_ARM64_ZIP_URL =
    'https://github.com/Ven0m0/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.0-latest-winarm64-gpl-8.0.zip'

/** Directory name inside the zip that contains the bin/ folder. */
const ZIP_INNER_DIR = 'ffmpeg-n8.0-latest-winarm64-gpl-8.0'

const CACHE_FOLDER_NAME = 'ffmpeg-arm64'

/** Cached results so we only resolve once per process lifetime. */
let cachedFfmpegPath: string | null | undefined
let cachedFfprobePath: string | null | undefined

/** In-flight download promise so concurrent callers share a single download. */
let downloadPromise: Promise<void> | null = null

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isWindowsArm64(): boolean {
    return process.platform === 'win32' && process.arch === 'arm64'
}

export async function resolveArm64Ffmpeg(): Promise<string | null> {
    if (!isWindowsArm64()) return null
    if (cachedFfmpegPath !== undefined) return cachedFfmpegPath

    await ensureBinariesDownloaded()

    const binPath = join(getCacheDir(), 'ffmpeg.exe')
    try {
        await access(binPath)
        cachedFfmpegPath = binPath
        return binPath
    } catch {
        cachedFfmpegPath = null
        return null
    }
}

export async function resolveArm64Ffprobe(): Promise<string | null> {
    if (!isWindowsArm64()) return null
    if (cachedFfprobePath !== undefined) return cachedFfprobePath

    await ensureBinariesDownloaded()

    const binPath = join(getCacheDir(), 'ffprobe.exe')
    try {
        await access(binPath)
        cachedFfprobePath = binPath
        return binPath
    } catch {
        cachedFfprobePath = null
        return null
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getCacheDir(): string {
    return join(app.getPath('userData'), CACHE_FOLDER_NAME)
}

async function ensureBinariesDownloaded(): Promise<void> {
    const cacheDir = getCacheDir()

    // Fast path: both binaries already exist on disk.
    const ffmpegPath = join(cacheDir, 'ffmpeg.exe')
    const ffprobePath = join(cacheDir, 'ffprobe.exe')
    try {
        await access(ffmpegPath)
        await access(ffprobePath)
        return // Already cached.
    } catch {
        // Need to download.
    }

    // Deduplicate concurrent callers.
    if (!downloadPromise) {
        downloadPromise = downloadAndExtract(cacheDir).finally(() => {
            downloadPromise = null
        })
    }
    await downloadPromise
}

async function downloadAndExtract(cacheDir: string): Promise<void> {
    let tempDir = ''

    try {
        await mkdir(cacheDir, { recursive: true })

        tempDir = await mkdtemp(join(tmpdir(), 'astra-ffmpeg-arm64-'))
        const zipPath = join(tempDir, 'ffmpeg-arm64.zip')

        console.log('[ffmpegArm64] Downloading ARM64 ffmpeg binaries…')
        await downloadFile(FFMPEG_ARM64_ZIP_URL, zipPath)

        console.log('[ffmpegArm64] Extracting binaries…')
        await extractWithTar(zipPath, tempDir)

        // Move the two binaries into the cache directory.
        const extractedBinDir = join(tempDir, ZIP_INNER_DIR, 'bin')
        for (const binary of ['ffmpeg.exe', 'ffprobe.exe']) {
            const src = join(extractedBinDir, binary)
            const dest = join(cacheDir, binary)
            // Use rename if same volume, otherwise fall back to copy.
            try {
                await rename(src, dest)
            } catch {
                // Cross-device: rename throws EXDEV, fall back to copy.
                await copyFile(src, dest)
            }
        }

        console.log('[ffmpegArm64] ARM64 binaries cached at', cacheDir)
    } catch (error: unknown) {
        console.warn('[ffmpegArm64] Failed to download/extract ARM64 ffmpeg binaries:', error)
    } finally {
        if (tempDir) {
            rm(tempDir, { recursive: true, force: true }).catch(() => { })
        }
    }
}

// ---------------------------------------------------------------------------
// Download helper — follows up to 5 redirects (GitHub serves 302 redirects).
// ---------------------------------------------------------------------------

function downloadFile(url: string, destPath: string, redirectsLeft = 5): Promise<void> {
    return new Promise((resolve, reject) => {
        if (redirectsLeft <= 0) {
            reject(new Error('Too many redirects'))
            return
        }

        const proto = url.startsWith('https') ? https : http
        const request = proto.get(url, (response: http.IncomingMessage) => {
            // Handle redirects.
            if (
                response.statusCode &&
                response.statusCode >= 300 &&
                response.statusCode < 400 &&
                response.headers.location
            ) {
                response.resume() // Drain the response body.
                downloadFile(response.headers.location, destPath, redirectsLeft - 1)
                    .then(resolve, reject)
                return
            }

            if (!response.statusCode || response.statusCode >= 400) {
                response.resume()
                reject(new Error(`HTTP ${response.statusCode} fetching ${url}`))
                return
            }

            const fileStream = createWriteStream(destPath)
            response.pipe(fileStream)
            fileStream.on('finish', () => {
                fileStream.close(() => resolve())
            })
            fileStream.on('error', (err: Error) => {
                fileStream.close(() => reject(err))
            })
        })
        request.on('error', reject)
        request.end()
    })
}

// ---------------------------------------------------------------------------
// Extract using Windows built-in `tar` (available since Windows 10 1803).
// ---------------------------------------------------------------------------

function extractWithTar(zipPath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(
            'tar',
            ['-xf', zipPath, '-C', destDir],
            { timeout: 120_000, windowsHide: true },
            (error: Error | null) => {
                if (error) {
                    reject(error)
                } else {
                    resolve()
                }
            }
        )
    })
}
