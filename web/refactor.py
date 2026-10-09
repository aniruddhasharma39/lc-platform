import os
import re

src_dir = r'c:\Users\PC\Desktop\Internship\BoomBarrier\lc-platform\web\src'
config_path = os.path.join(src_dir, 'config.ts')

with open(config_path, 'w') as f:
    f.write("export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5001';\n")

for root, _, files in os.walk(src_dir):
    for file in files:
        if file.endswith('.tsx') or file.endswith('.ts'):
            if file == 'config.ts': continue
            filepath = os.path.join(root, file)
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()
            
            if 'http://localhost:5001' in content or 'https://lc-platform.onrender.com' in content:
                # Add import if not exists
                if 'import { API_URL }' not in content:
                    lines = content.split('\n')
                    last_import = 0
                    for i, line in enumerate(lines):
                        if line.startswith('import '):
                            last_import = i
                    rel_path = os.path.relpath(src_dir, root).replace('\\', '/')
                    if rel_path == '.':
                        import_stmt = "import { API_URL } from './config';"
                    else:
                        import_stmt = f"import {{ API_URL }} from '{rel_path}/config';"
                    lines.insert(last_import + 1, import_stmt)
                    content = '\n'.join(lines)

                # Replace 'http://localhost:5001/...' with `${API_URL}/...`
                content = re.sub(r"'http://localhost:5001([^']*)'", r"`${API_URL}\1`", content)
                # Replace `http://localhost:5001/...` with `${API_URL}/...`
                content = re.sub(r"`http://localhost:5001([^`]*)`", r"`${API_URL}\1`", content)

                # Replace 'https://lc-platform.onrender.com/...' with `${API_URL}/...`
                content = re.sub(r"'https://lc-platform.onrender.com([^']*)'", r"`${API_URL}\1`", content)
                # Replace `https://lc-platform.onrender.com/...` with `${API_URL}/...`
                content = re.sub(r"`https://lc-platform.onrender.com([^`]*)`", r"`${API_URL}\1`", content)
                
                with open(filepath, 'w', encoding='utf-8') as f:
                    f.write(content)
