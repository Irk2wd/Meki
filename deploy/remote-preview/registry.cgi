#!/usr/bin/python3
"""Apache authenticates administrators and invokes this API on the admin origin."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from admin_registry import serve

serve()
