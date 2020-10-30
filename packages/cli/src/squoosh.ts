/* eslint-disable @typescript-eslint/no-var-requires */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const minimatch = require('minimatch');
const tmp = require('tmp');

import { sync as commandExistsSync } from 'command-exists';
import { BufferUtils, Document, FileUtils, ImageUtils, Transform } from '@gltf-transform/core';
import { TextureWebP } from '@gltf-transform/extensions';
import { formatBytes, getTextureSlots } from './util';

tmp.setGracefulCleanup();

// Configuration: https://github.com/GoogleChromeLabs/squoosh/blob/visdf/cli/src/codecs.js

export interface WebPOptions {
	slots?: string;
	formats?: string;
	quality?: number;
}

export interface MozJPEGOptions {
	slots?: string;
	formats?: string;
	quality?: number;
}

export interface OxiPNGOptions {
	slots?: string;
	formats?: string;
	effort?: number;
}

const WEBP_DEFAULT_OPTIONS: WebPOptions = {slots: '*'};
const MOZJPEG_DEFAULT_OPTIONS: MozJPEGOptions = {slots: '*', formats: 'jpeg'};
const OXIPNG_DEFAULT_OPTIONS: OxiPNGOptions = {slots: '*', formats: 'png'};

interface SquooshOptions {
	slots?: string;
	formats?: string;
	flags: string[];
	outExtension: string;
	outMimeType: string;
}

export const webp = function (options: WebPOptions = WEBP_DEFAULT_OPTIONS): Transform {
	options = {...WEBP_DEFAULT_OPTIONS, ...options};

	return (doc: Document): void => {
		doc.createExtension(TextureWebP).setRequired(true);
		return squoosh({
			formats: options.formats,
			slots: options.slots,
			flags: ['--webp', `"${JSON.stringify({quality: options.quality})}"`],
			outExtension: 'webp',
			outMimeType: 'image/webp',
		})(doc);
	};
}

export const mozjpeg = function (options: MozJPEGOptions = MOZJPEG_DEFAULT_OPTIONS): Transform {
	options = {...MOZJPEG_DEFAULT_OPTIONS, ...options};
	return (doc: Document): void => {
		return squoosh({
			formats: options.formats,
			slots: options.slots,
			flags: ['--mozjpeg', `"${JSON.stringify({quality: options.quality})}"`],
			outExtension: 'jpg',
			outMimeType: 'image/jpeg',
		})(doc);
	};
}

export const oxipng = function (options: OxiPNGOptions = OXIPNG_DEFAULT_OPTIONS): Transform {
	options = {...OXIPNG_DEFAULT_OPTIONS, ...options};
	return (doc: Document): void => {
		return squoosh({
			formats: options.formats,
			slots: options.slots,
			flags: ['--oxipng', `"${JSON.stringify({effort: options.effort})}"`],
			outExtension: 'png',
			outMimeType: 'image/png',
		})(doc);
	};
}

/** Uses Squoosh CLI to compress textures with the specified encoder. */
const squoosh = function (options: SquooshOptions): Transform {
	return (doc: Document): void => {
		const logger = doc.getLogger();

		if (!commandExistsSync('squoosh-cli') && !process.env.CI) {
			throw new Error('Command "squoosh-cli" not found. Please install "@squoosh/cli" from NPM.');
		}

		let numCompressed = 0;

		doc.getRoot()
			.listTextures()
			.forEach((texture, textureIndex) => {
				const textureSlots = getTextureSlots(doc, texture);
				const textureLabel = texture.getURI()
					|| texture.getName()
					|| `${textureIndex + 1}/${doc.getRoot().listTextures().length}`;

				// Filter textures by 'formats' and 'slots' patterns.
				if (options.formats !== '*' && texture.getMimeType() !== `image/${options.formats}`) {
					logger.debug(`• Skipping ${textureLabel}, excluded by formats "${options.formats}".`);
					return;
				} else if (options.slots !== '*'
						&& !textureSlots.find((slot) => minimatch(slot, options.slots, {nocase: true}))) {
					logger.debug(`• Skipping ${textureLabel}, excluded by slots "${options.slots}".`);
					return;
				}

				// Create temporary in/out paths for the 'squoosh-cli' tool.
				const inExtension = texture.getURI()
					? FileUtils.extension(texture.getURI())
					: ImageUtils.mimeTypeToExtension(texture.getMimeType());
				const inPath = tmp.tmpNameSync({postfix: '.' + inExtension});
				const outDir = tmp.dirSync().name;
				const outPath = options.outExtension
					? path.join(outDir, path.basename(inPath).replace('.' + inExtension, '.' + options.outExtension))
					: path.join(outDir, path.basename(inPath));

				const inBytes = texture.getImage().byteLength;
				fs.writeFileSync(inPath, Buffer.from(texture.getImage()));

				logger.debug(`• squoosh-cli ${options.flags.join(' ')} --output-dir ${outDir} ${inPath}`);

				// Run `squoosh-cli` CLI tool.
				const {status, error} = spawnSync('squoosh-cli', [...options.flags, '--output-dir', outDir, inPath], {stdio: [process.stderr]});

				if (status !== 0) {
					logger.error('• Texture compression failed.');
					throw error || new Error('Texture compression failed');
				}

				texture
					.setImage(BufferUtils.trim(fs.readFileSync(outPath)))
					.setMimeType('image/' + options.outExtension);
				if (texture.getURI()) {
					texture.setURI(FileUtils.basename(texture.getURI()) + '.' + options.outExtension);
				}

				numCompressed++;

				const outBytes = texture.getImage().byteLength;
				logger.info(`• Texture ${textureLabel} (${textureSlots.join(', ')}) ${formatBytes(inBytes)} → ${formatBytes(outBytes)}.`);
			});

		if (numCompressed === 0) {
			logger.warn('No textures were found, or none were selected for compression.');
		}
	};
}
