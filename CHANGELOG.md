# Changelog

## [0.3.0](https://github.com/walkflow-app/ftms-treadmill/compare/v0.2.1...v0.3.0) (2026-11-16)


### ⚠ BREAKING CHANGES

* close the smaller promise gaps ([#32](https://github.com/walkflow-app/ftms-treadmill/issues/32))
* sendRaw sends only bytes 0-255, so the check sees what goes out ([#31](https://github.com/walkflow-app/ftms-treadmill/issues/31))

### Safety

* close the smaller promise gaps ([#32](https://github.com/walkflow-app/ftms-treadmill/issues/32)) ([f81bcea](https://github.com/walkflow-app/ftms-treadmill/commit/f81bceaf70606942f0461312f112b6747dc4bdb7))
* sendRaw sends only bytes 0-255, so the check sees what goes out ([#31](https://github.com/walkflow-app/ftms-treadmill/issues/31)) ([76a10bb](https://github.com/walkflow-app/ftms-treadmill/commit/76a10bbcbaa08ebaf6ea8c32d5ecb00624051c48))

## [0.2.1](https://github.com/walkflow-app/ftms-treadmill/compare/v0.2.0...v0.2.1) (2026-11-13)


### Chores

* release 0.2.1 ([dc77f23](https://github.com/walkflow-app/ftms-treadmill/commit/dc77f238b90aef752aef89810787e370e824a265))

## [0.2.0](https://github.com/walkflow-app/ftms-treadmill/compare/v0.1.2...v0.2.0) (2026-11-13)


### ⚠ BREAKING CHANGES

* **treadmill:** ended comes once per run of the belt ([#6](https://github.com/walkflow-app/ftms-treadmill/issues/6))

### Safety

* **treadmill:** ended comes once per run of the belt ([#6](https://github.com/walkflow-app/ftms-treadmill/issues/6)) ([cfea207](https://github.com/walkflow-app/ftms-treadmill/commit/cfea20755ebb34df4e0824a04d74804262f4fd56))

## [0.1.2](https://github.com/walkflow-app/ftms-treadmill/compare/v0.1.1...v0.1.2) (2026-11-13)


### Fixes

* point the npm page to this repository and its docs ([#1](https://github.com/walkflow-app/ftms-treadmill/issues/1)) ([1edac28](https://github.com/walkflow-app/ftms-treadmill/commit/1edac28270e18bdeaffa7c18e6c5ea1e21512d0e))

## [0.1.1](https://github.com/walkflow-app/walkflow/compare/ftms-treadmill-v0.1.0...ftms-treadmill-v0.1.1) (2026-11-12)


### Fixes

* **ftms-treadmill:** link the npm homepage to the package README ([#23](https://github.com/walkflow-app/walkflow/issues/23)) ([cb86df7](https://github.com/walkflow-app/walkflow/commit/cb86df7a16edc19d8b340fdeb2f818b20dda0a0d))

## 0.1.0 (2026-11-12)


### Safety

* **treadmill:** Start after a stop or pause ramps up to the last speed again ([b7e688f](https://github.com/walkflow-app/walkflow/commit/b7e688f62ac427fd3f511e01a61a8e97ab7075a3))


### Features

* **incline:** incline levels start at 0 and the card shows only the level buttons ([b7e688f](https://github.com/walkflow-app/walkflow/commit/b7e688f62ac427fd3f511e01a61a8e97ab7075a3))
* **incline:** set the incline only while the belt runs and follow the incline the treadmill reports ([b7e688f](https://github.com/walkflow-app/walkflow/commit/b7e688f62ac427fd3f511e01a61a8e97ab7075a3))
* **incline:** the incline is no longer marked experimental ([b7e688f](https://github.com/walkflow-app/walkflow/commit/b7e688f62ac427fd3f511e01a61a8e97ab7075a3))
* **treadmill:** move the treadmill control into the ftms-treadmill library ([b7e688f](https://github.com/walkflow-app/walkflow/commit/b7e688f62ac427fd3f511e01a61a8e97ab7075a3))
