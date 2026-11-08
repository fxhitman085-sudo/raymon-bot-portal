# Vendored libsignal dependency

`libsignal-6.0.0.tgz` contains the unmodified runtime source of WhiskeySockets/libsignal-node version 6.0.0, from commit `bcea72df9ec34d9d9140ab30619cf479c7c144c7`, previously resolved by this project’s lockfile.

Upstream: https://github.com/WhiskeySockets/libsignal-node

The archive includes the upstream GPL-3.0 LICENSE, README, JavaScript sources and type declarations. It was produced with `npm pack ./node_modules/libsignal --ignore-scripts`. No cryptographic code was changed. npm registry dependencies remain in package-lock.json.

The package.json override uses this local archive because the hosting environment disables Git dependencies. Keep this directory when deploying. Updating Baileys/libsignal requires reviewing and refreshing this archive and lockfile together.
