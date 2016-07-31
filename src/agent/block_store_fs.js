/**
 *
 * BLOCK STORE FS
 *
 */
'use strict';

const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const mkdirp = require('mkdirp');

const P = require('../util/promise');
const dbg = require('../util/debug_module')(__filename);
const fs_utils = require('../util/fs_utils');
const os_utils = require('../util/os_utils');
const Semaphore = require('../util/semaphore');
const BlockStoreBase = require('./block_store_base').BlockStoreBase;
const string_utils = require('../util/string_utils');

class BlockStoreFs extends BlockStoreBase {

    constructor(options) {
        super(options);
        this.root_path = options.root_path;
        this.blocks_path_root = path.join(this.root_path, 'blocks_tree');
        this.old_blocks_path = path.join(this.root_path, 'blocks');
        this.config_path = path.join(this.root_path, 'config');
    }

    init() {
        // create internal directories to hold blocks by their last 3 hex digits
        // this is done to reduce the number of files in one directory which leads
        // to bad performance
        let num_digits = 3;
        let dir_list = [];
        let num_dirs = Math.pow(16, num_digits);
        for (let i = 0; i < num_dirs; ++i) {
            let dir_str = string_utils.left_pad_zeros(i.toString(16), num_digits) + '.blocks';
            dir_list.push(path.join(this.blocks_path_root, dir_str));
        }
        dir_list.push(path.join(this.blocks_path_root, 'other.blocks'));

        return P.map(dir_list, dir => fs_utils.create_path(dir), {
                concurrency: 10
            })
            .then(() => this.upgrade_dir_structure());
    }

    get_storage_info() {
        return P.join(
                this._get_usage(),
                os_utils.get_drive_of_path(this.root_path))
            .spread((usage, drive) => {
                const storage = drive.storage;
                storage.used = usage.size;
                return storage;
            });
    }

    _read_block(block_md) {
        const block_path = this._get_block_data_path(block_md.id);
        const meta_path = this._get_block_meta_path(block_md.id);
        dbg.log1('fs read block', block_path);
        return P.join(
                fs.readFileAsync(block_path),
                fs.readFileAsync(meta_path))
            .spread((data_file, meta_file) => {
                return {
                    block_md: block_md,
                    data: data_file,
                };
            });
    }

    _write_block(block_md, data) {
        let overwrite_stat;
        const block_path = this._get_block_data_path(block_md.id);
        const meta_path = this._get_block_meta_path(block_md.id);
        const block_md_to_store = _.pick(block_md, 'id', 'digest_type', 'digest_b64');
        const block_md_data = JSON.stringify(block_md_to_store);


        return P.fcall(() => fs.statAsync(block_path).catch(ignore_not_found))
            .then(stat => {
                overwrite_stat = stat;
                dbg.log1('_write_block', block_path, data.length, overwrite_stat);
                // create/replace the block on fs
                return P.join(
                    fs.writeFileAsync(block_path, data),
                    fs.writeFileAsync(meta_path, block_md_data));
            })
            .then(() => {
                if (this._usage) {
                    this._usage.size += data.length + block_md_data.length;
                    this._usage.count += 1;
                    if (overwrite_stat) {
                        this._usage.size -= overwrite_stat.size;
                        this._usage.count -= 1;
                    }
                }
            });

    }

    _delete_blocks(block_ids) {
        return P.map(block_ids,
            block_id => this._delete_block(block_id)
            .catch(err => {
                // TODO handle failed deletions - report to server and reclaim later
                dbg.warn('delete block failed due to', err);
            }), {
                // limit concurrency with semaphore
                concurrency: 10
            });
    }

    _delete_block(block_id) {
        const block_path = this._get_block_data_path(block_id);
        const meta_path = this._get_block_meta_path(block_id);
        let del_stat;

        dbg.log("delete block", block_id);
        return fs.statAsync(block_path).catch(ignore_not_found)
            .then(stat => {
                del_stat = stat;
                return P.join(
                    fs.unlinkAsync(block_path).catch(ignore_not_found),
                    fs.unlinkAsync(meta_path).catch(ignore_not_found));
            })
            .then(() => {
                if (this._usage && del_stat) {
                    this._usage.size -= del_stat.size;
                    this._usage.count -= 1;
                }
            });
    }

    _get_usage() {
        return this._usage || this._count_usage();
    }

    _count_usage() {
        const sem = new Semaphore(10);
        return fs_utils.disk_usage(this.blocks_path_root, sem, true)
            .then(usage => {
                dbg.log0('counted disk usage', usage);
                this._usage = usage; // object with properties size and count
                return usage;
            });
    }

    _read_config() {
        return fs.readFileAsync(this.config_path)
            .catch(ignore_not_found)
            .then(data => JSON.parse(data));
    }

    _get_alloc() {
        return this._read_config()
            .then(config => config && config.alloc || 0);
    }

    _set_alloc(size) {
        return this._read_config()
            .then(config => {
                config = config || {};
                config.alloc = size;
                return this._write_config(config);
            });
    }

    _write_config(config) {
        const data = JSON.stringify(config);
        return fs.writeFileAsync(this.config_path, data);
    }

    _get_block_data_path(block_id) {
        let block_dir = this._get_block_internal_dir(block_id);
        return path.join(this.blocks_path_root, block_dir, block_id + '.data');
    }

    _get_block_meta_path(block_id) {
        let block_dir = this._get_block_internal_dir(block_id);
        return path.join(this.blocks_path_root, block_dir, block_id + '.meta');
    }

    _get_block_other_path(file) {
        let block_dir = this._get_block_internal_dir('other');
        return path.join(this.blocks_path_root, block_dir, file);
    }
    upgrade_dir_structure() {
        let concurrency = 10; // the number of promises to use for moving blocks - set arbitrarily for now
        return fs.readdirAsync(this.old_blocks_path)
            .then(files => {
                dbg.log2('found', files.length, 'files to move. files:', files);
                return P.map(files, file => {
                    let file_split = file.split('.');
                    let new_path = this._get_block_other_path(file);
                    if (file_split.length === 2) {
                        let block_id = file_split[0];
                        let suffix = file_split[1];
                        if (suffix === 'data') new_path = this._get_block_data_path(block_id);
                        else if (suffix === 'meta') new_path = this._get_block_meta_path(block_id);
                    }
                    let old_path = path.join(this.old_blocks_path, file);
                    return fs.renameAsync(old_path, new_path)
                        .catch(err => dbg.error('upgrade_dir_structure: failed moving from:', old_path, 'to:', new_path));
                }, {
                    concurrency: concurrency
                });
            })
            .then(() => fs.rmdirAsync(this.old_blocks_path))
            .catch(err => {
                dbg.error('readdir on', this.old_blocks_path, 'failed with error:', err);
            });
    }

}

function ignore_not_found(err) {
    if (err.code === 'ENOENT') return;
    throw err;
}

// EXPORTS
exports.BlockStoreFs = BlockStoreFs;
