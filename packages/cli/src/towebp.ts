/* eslint-disable @typescript-eslint/no-var-requires */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const minimatch = require('minimatch');
const tmp = require('tmp');

import { sync as commandExistsSync } from 'command-exists';
import { BufferUtils, Document, FileUtils, ImageUtils, Texture, Transform } from '@gltf-transform/core';
import { TextureWebP } from '@gltf-transform/extensions';
import { formatBytes } from './util';

tmp.setGracefulCleanup();

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface WebPOptions {
	slots?: string;
}

const DEFAULT_OPTIONS: WebPOptions = {slots: '*'};

/**
 * TODO(feat): Configuration via https://github.com/GoogleChromeLabs/squoosh/blob/visdf/cli/src/codecs.js.
 */
export const towebp = function (options: WebPOptions = {}): Transform {

	options = {...DEFAULT_OPTIONS, ...options};

	return (doc: Document): void =>  {
		const logger = doc.getLogger();

		if (!commandExistsSync('squoosh-cli') && !process.env.CI) {
			throw new Error('Command "squoosh-cli" not found. Please install "@squoosh/cli" from NPM.');
		}

		doc.createExtension(TextureWebP).setRequired(true);

		let numCompressed = 0;

		doc.getRoot()
			.listTextures()
			.forEach((texture, textureIndex) => {
				const slots = getTextureSlots(doc, texture);
				const textureLabel = texture.getURI()
					|| texture.getName()
					|| `${textureIndex + 1}/${doc.getRoot().listTextures().length}`;
				logger.debug(`Texture ${textureLabel} (${slots.join(', ')})`);

				// Exclude textures that don't match the 'slots' glob, or are already KTX.
				if (texture.getMimeType() === 'image/webp') {
					logger.debug('• Skipping, already WebP.');
					return;
				} else if (options.slots !== '*' && !slots.find((slot) => minimatch(slot, options.slots, {nocase: true}))) {
					logger.debug(`• Skipping, excluded by pattern "${options.slots}".`);
					return;
				}

				// Create temporary in/out paths for the 'toktx' CLI tool.
				const extension = texture.getURI()
					? FileUtils.extension(texture.getURI())
					: ImageUtils.mimeTypeToExtension(texture.getMimeType());
				const inPath = tmp.tmpNameSync({postfix: '.' + extension});
				const outPath = inPath.replace('.' + extension, '.webp');
				const outDir = path.dirname(outPath);

				const inBytes = texture.getImage().byteLength;
				fs.writeFileSync(inPath, Buffer.from(texture.getImage()));

				logger.debug(`• squoosh-cli --webp --ouput-dir ${outDir} ${inPath}`);

				// Run `squoosh-cli` CLI tool.
				const {status, error} = spawnSync('squoosh-cli', ['--webp', '--output-dir', outDir, inPath], {stdio: [process.stderr]});

				if (status !== 0) {
					logger.error('• Texture compression failed.');
					throw error || new Error('Texture compression failed');
				}

				texture
					.setImage(BufferUtils.trim(fs.readFileSync(outPath)))
					.setMimeType('image/webp');

				if (texture.getURI()) {
					texture.setURI(FileUtils.basename(texture.getURI()) + '.webp');
				}

				numCompressed++;

				const outBytes = texture.getImage().byteLength;
				logger.debug(`• ${formatBytes(inBytes)} → ${formatBytes(outBytes)} bytes.`);
			});

		if (numCompressed === 0) {
			logger.warn('No textures were found, or none were selected for compression.');
		}
	};
}

/** Returns names of all texture slots using the given texture. */
function getTextureSlots (doc: Document, texture: Texture): string[] {
	return doc.getGraph().getLinks()
		.filter((link) => link.getChild() === texture)
		.map((link) => link.getName())
		.filter((slot) => slot !== 'texture')
}
