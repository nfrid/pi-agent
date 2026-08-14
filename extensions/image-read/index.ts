import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createReadToolDefinition,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { cropRasterImage, IMAGE_CROP_LIMITS, type ImageCrop } from './crop.js';

const cropSchema = Type.Object(
  {
    x: Type.Integer({ minimum: 0, description: 'Left edge in source pixels' }),
    y: Type.Integer({ minimum: 0, description: 'Top edge in source pixels' }),
    width: Type.Integer({
      minimum: 1,
      maximum: IMAGE_CROP_LIMITS.maxCropDimension,
      description: 'Crop width in source pixels',
    }),
    height: Type.Integer({
      minimum: 1,
      maximum: IMAGE_CROP_LIMITS.maxCropDimension,
      description: 'Crop height in source pixels',
    }),
  },
  { additionalProperties: false },
);

const readSchema = Type.Object(
  {
    path: Type.String({
      description: 'Path to the file to read (relative or absolute)',
    }),
    offset: Type.Optional(
      Type.Number({
        description: 'Line number to start reading from (1-indexed)',
      }),
    ),
    limit: Type.Optional(
      Type.Number({ description: 'Maximum number of lines to read' }),
    ),
    crop: Type.Optional(cropSchema),
  },
  { additionalProperties: false },
);

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const DESCRIPTION = `Read the contents of a file. Supports text files and raster images (jpg, png, gif, webp, bmp). Images are sent as attachments. For images, crop selects an exact source-pixel region and reports source/returned dimensions; crops are limited to ${IMAGE_CROP_LIMITS.maxCropDimension}x${IMAGE_CROP_LIMITS.maxCropDimension} and ${IMAGE_CROP_LIMITS.maxCropPixels.toLocaleString('en-US')} pixels. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.`;

function normalizeReadPath(path: string, cwd: string): string {
  let normalized = path.replace(UNICODE_SPACES, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (normalized === '~') return homedir();
  if (normalized.startsWith('~/'))
    normalized = join(homedir(), normalized.slice(2));
  if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
  return isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(cwd, normalized);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveReadPath(path: string, cwd: string): Promise<string> {
  const resolved = normalizeReadPath(path, cwd);
  const variants = [
    resolved,
    resolved.replace(/ (AM|PM)\./gi, '\u202F$1.'),
    resolved.normalize('NFD'),
    resolved.replace(/'/g, '\u2019'),
    resolved.normalize('NFD').replace(/'/g, '\u2019'),
  ];
  for (const variant of new Set(variants)) {
    if (await pathExists(variant)) return variant;
  }
  return resolved;
}

export default function imageReadExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'read',
    label: 'read',
    description: DESCRIPTION,
    promptSnippet: 'Read file contents or an exact raster-image crop',
    parameters: readSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!params.crop) {
        const builtIn = createReadToolDefinition(ctx.cwd);
        return builtIn.execute(toolCallId, params, signal, onUpdate, ctx);
      }
      if (params.offset !== undefined || params.limit !== undefined) {
        throw new Error(
          'Image crop cannot be combined with text offset or limit.',
        );
      }
      signal?.throwIfAborted();
      const sourcePath = await resolveReadPath(params.path, ctx.cwd);
      const sourceStat = await stat(sourcePath);
      if (sourceStat.size > IMAGE_CROP_LIMITS.maxSourceBytes) {
        throw new Error('Image source exceeds the 50MB crop input limit.');
      }
      const bytes = await readFile(sourcePath);
      signal?.throwIfAborted();
      const result = await cropRasterImage(
        bytes,
        params.crop as ImageCrop,
        signal,
      );
      signal?.throwIfAborted();

      let text = `Read image crop [${result.mimeType}]\nSource: ${result.sourceWidth}x${result.sourceHeight}; returned: ${result.width}x${result.height}; region: (${params.crop.x},${params.crop.y})-(${params.crop.x + params.crop.width},${params.crop.y + params.crop.height}).`;
      if (ctx.model && !ctx.model.input.includes('image')) {
        text +=
          '\n[Current model does not support images. The image will be omitted from this request.]';
      }
      return {
        content: [
          { type: 'text', text },
          { type: 'image', data: result.data, mimeType: result.mimeType },
        ],
        details: {
          crop: params.crop,
          sourceWidth: result.sourceWidth,
          sourceHeight: result.sourceHeight,
          returnedWidth: result.width,
          returnedHeight: result.height,
        },
      };
    },
  });
}
