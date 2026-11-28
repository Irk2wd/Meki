"""Versions accepted by the installer release workflows."""
import re


NUMBER = r'(?:0|[1-9][0-9]{0,5})'
VERSION = rf'{NUMBER}\.{NUMBER}\.{NUMBER}(?:-beta\.[1-9][0-9]{{0,5}})?'


def version_key(version):
    core, separator, beta = version.partition('-beta.')
    return (*map(int, core.split('.')), not separator, int(beta or 0))
