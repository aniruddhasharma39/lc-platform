#!/bin/bash
# Install Node dependencies for workspaces
npm install

# Install Flutter dependencies
cd mobile && flutter pub get && cd ..
