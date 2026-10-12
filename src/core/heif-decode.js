import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

export const HEIF_WARNING = '无法解码 HEIF：请在微软商店安装「HEIF 图像扩展」和「HEVC 视频扩展」后重新打开';
export const RAW_WIC_WARNING = 'Windows 没有可用的 RAW 解码器：可在微软商店安装「Raw 图像扩展」';

// WPF imaging goes through the WIC codecs installed from the Microsoft Store (HEIF, Raw Image Extension).
// Output is upright 8-bit sRGB-ish JPEG; orientation is reported so callers never rotate twice.
export function windowsWicScript() {
  return `param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$Output,[int]$Rotate=1)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
$imaging = 'System.Windows.Media.Imaging'
$stream = [System.IO.File]::Open($Source, 'Open', 'Read', 'ReadWrite')
try {
  $decoder = [System.Windows.Media.Imaging.BitmapDecoder]::Create($stream,
    [System.Windows.Media.Imaging.BitmapCreateOptions]::None, [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
  $frame = $decoder.Frames[0]
  $orientation = 1
  foreach ($query in 'System.Photo.Orientation', '/app1/ifd/{ushort=274}', '/ifd/{ushort=274}') {
    try { $value = $frame.Metadata.GetQuery($query); if ($value) { $orientation = [int]$value; break } } catch {}
  }
  $bitmap = $frame
  if ($bitmap.Format -ne [System.Windows.Media.PixelFormats]::Bgr24) {
    $bitmap = New-Object "$imaging.FormatConvertedBitmap" ($bitmap, [System.Windows.Media.PixelFormats]::Bgr24, $null, 0)
  }
  $applied = 1
  if ($Rotate -eq 1 -and $orientation -gt 1 -and $orientation -le 8) {
    $group = New-Object System.Windows.Media.TransformGroup
    if (@(2, 4, 5, 7) -contains $orientation) { $group.Children.Add((New-Object System.Windows.Media.ScaleTransform (-1, 1))) }
    $angle = @{ 3 = 180; 4 = 180; 5 = 270; 6 = 90; 7 = 90; 8 = 270 }[$orientation]
    if ($angle) { $group.Children.Add((New-Object System.Windows.Media.RotateTransform ($angle))) }
    $bitmap = New-Object "$imaging.TransformedBitmap" ($bitmap, $group)
    $applied = $orientation
  }
  $encoder = New-Object "$imaging.JpegBitmapEncoder"
  $encoder.QualityLevel = 95
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $out = [System.IO.File]::Open($Output, 'Create')
  try { $encoder.Save($out) } finally { $out.Dispose() }
  $codec = $decoder.CodecInfo.FriendlyName
  Write-Output ('{"width":' + $bitmap.PixelWidth + ',"height":' + $bitmap.PixelHeight + ',"orientation":' + $orientation +
    ',"applied":' + $applied + ',"codec":"' + ($codec -replace '"', '') + '"}')
} finally { $stream.Dispose() }`;
}

const wicHealth = { successes: 0, failures: 0 };
export function wicAvailable() { return wicHealth.successes > 0 || wicHealth.failures < 3; }
export function resetWicHealth() { wicHealth.successes = 0; wicHealth.failures = 0; }

export function parseWicOutput(text) {
  const match = /\{"width":\d+.*\}/.exec(String(text || ''));
  if (!match) throw new Error('WIC 没有返回图像信息');
  return JSON.parse(match[0]);
}

export async function decodeWic(source, { temporaryDir, runCommand, rotate = true, timeoutMs = 90000 } = {}) {
  if (!wicAvailable()) throw new Error('WIC 解码器在本次运行中多次失败，已跳过');
  const dir = temporaryDir || await mkdtemp(path.join(os.tmpdir(), 'eagle-wic-'));
  const script = path.join(dir, 'wic.ps1'), output = path.join(dir, 'wic.jpg');
  await writeFile(script, windowsWicScript(), 'utf8');
  try {
    const text = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, '-Source', source, '-Output', output, '-Rotate', rotate ? '1' : '0'], { timeoutMs });
    const info = parseWicOutput(text);
    wicHealth.successes++;
    return { input: output, kind: 'wic', ...info };
  } catch (error) {
    wicHealth.failures++;
    throw error;
  }
}

async function probeSharp(input, impl) {
  if (!impl?.format?.heif?.input) throw new Error('sharp HEIF input unsupported');
  const buffer = await impl(input).rotate().jpeg({ quality: 95 }).toBuffer();
  const meta = await impl(buffer).metadata();
  if (!meta.width || !meta.height || !buffer.length) throw new Error('sharp HEIF decode produced no image');
  return { input: buffer, kind: 'heif-sharp', orientation: 1 };
}

export async function decodeHeif(source, { temporaryDir, runCommand, sharpImpl = sharp, platform = process.platform } = {}) {
  const warnings = [];
  const dir = temporaryDir || await mkdtemp(path.join(os.tmpdir(), 'eagle-heif-'));
  if (platform === 'darwin' && runCommand) {
    try {
      const output = path.join(dir, 'sips.jpg');
      await runCommand('sips', ['-s', 'format', 'jpeg', source, '--out', output]);
      // sips keeps the EXIF orientation tag instead of rotating pixels; the caller reads it from the JPEG.
      return { input: output, kind: 'heif', orientation: null, warnings };
    } catch (error) { warnings.push(`sips: ${error.message}`); }
  }
  try { return { ...(await probeSharp(source, sharpImpl)), warnings }; } catch (error) { warnings.push(`sharp: ${error.message}`); }
  if (platform === 'win32' && runCommand) {
    try {
      const decoded = await decodeWic(source, { temporaryDir: dir, runCommand });
      return { input: decoded.input, kind: 'heif-wic', orientation: 1, sourceOrientation: decoded.orientation, warnings };
    } catch (error) { warnings.push(`WIC: ${error.message}`); }
  }
  return { available: false, warnings, warning: platform === 'win32' ? HEIF_WARNING : 'HEIF 解码器不可用' };
}
