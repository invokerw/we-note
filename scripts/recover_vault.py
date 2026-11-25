#!/usr/bin/env python3
"""从已复制的 WeNote 库目录校验并重建正文树、历史版本、回收站和图片。"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tempfile


def child(root, relative):
    parts = PurePosixPath(relative).parts
    if not parts or '\\' in relative or relative.startswith('/') or '..' in parts:
        raise ValueError(f'无效的库内路径 {relative}')
    path = root.joinpath(*parts).resolve()
    if not path.is_relative_to(root):
        raise ValueError(f'路径超出库目录 {relative}')
    return path


def copy_checked(source, dest, expected, size):
    dest.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    with source.open('rb') as reader, dest.open('xb') as writer:
        while block := reader.read(1 << 20):
            digest.update(block)
            writer.write(block)
    if dest.stat().st_size != size or 'sha256:' + digest.hexdigest() != expected:
        raise ValueError(f'内容校验失败 {source}')


def recover(source, destination):
    source, destination = source.resolve(), destination.absolute()
    if destination.exists() or destination.resolve().is_relative_to(source):
        raise ValueError('请选择库目录之外的新目标目录')
    manifest_bytes = (source / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest['format_version'] != 1:
        raise ValueError('未知的清单版本')
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        output = Path(temporary, 'vault').resolve()
        output.mkdir()
        versions = {}
        for entry in manifest['versions']:
            relative = entry['object']
            dest = child(output / 'history', relative)
            copy_checked(child(source, relative), dest, entry['content_hash'], entry['content_size'])
            versions[(entry['file_id'], entry['version_id'])] = dest
        for note in manifest['notes']:
            version = versions[(note['file_id'], note['current_version_id'])]
            root = child(output / 'trash', note['file_id']) if note['is_deleted'] else output / 'notes'
            copy_checked(version, child(root, note['path']), note['current_content_hash'], note['current_content_size'])
        seen = {}
        for asset in manifest['assets']:
            relative = asset['object']
            identity = (asset['content_hash'], asset['content_size'])
            if relative in seen:
                if seen[relative] != identity:
                    raise ValueError(f'同一对象存在冲突 {relative}')
                continue
            seen[relative] = identity
            dest = child(output, relative) if relative.startswith('assets/') else child(output / 'legacy', relative)
            copy_checked(child(source, relative), dest, *identity)
        if manifest_bytes != (source / 'manifest.json').read_bytes():
            raise ValueError('复制期间库清单已更新，请使用同一修订的副本')
        (output / 'manifest.json').write_bytes(manifest_bytes)
        os.rename(output, destination)
    return manifest['revision']


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    print(f'已恢复库修订 {recover(args.source, args.destination)}')
