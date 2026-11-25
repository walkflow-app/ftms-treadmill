# Changelog

## [0.4.0](https://github.com/walkflow-app/ftms-treadmill/compare/v0.3.0...v0.4.0) (2026-11-25)


### ⚠ BREAKING CHANGES

* **governor:** one implausible speed reading no longer lifts the ramp base ([#44](https://github.com/walkflow-app/ftms-treadmill/issues/44))
* **stop:** a Stop is not overtaken by Start, raw Stop is a Stop, connect() re-entrant, refused control ([#52](https://github.com/walkflow-app/ftms-treadmill/issues/52))
* **start:** no Start when the start speed was not set, nothing on a moving belt ([#43](https://github.com/walkflow-app/ftms-treadmill/issues/43))

### Safety

* **governor:** a ramp step waiting in the write queue is withdrawn when the limit was lowered below it ([#54](https://github.com/walkflow-app/ftms-treadmill/issues/54)) ([34c260e](https://github.com/walkflow-app/ftms-treadmill/commit/34c260e459b118e43f089c2358f9b5502ee160e4))
* **governor:** no ramp step during the treadmill's start countdown ([#63](https://github.com/walkflow-app/ftms-treadmill/issues/63)) ([7442979](https://github.com/walkflow-app/ftms-treadmill/commit/7442979ddd4adfcb4b896dc3a821f92584f9fdad))
* **governor:** nothing is sent while the belt coasts down after a stop ([#56](https://github.com/walkflow-app/ftms-treadmill/issues/56)) ([24cadf1](https://github.com/walkflow-app/ftms-treadmill/commit/24cadf11f313a1edad6ea120d8754a4fcf138b0b))
* **governor:** one implausible speed reading no longer lifts the ramp base ([#44](https://github.com/walkflow-app/ftms-treadmill/issues/44)) ([96a97d1](https://github.com/walkflow-app/ftms-treadmill/commit/96a97d1c8fb7507022efe492b2a854c1a5b2d246))
* **governor:** Training Status 0f starts the wait after a stop at once ([#60](https://github.com/walkflow-app/ftms-treadmill/issues/60)) ([11f6746](https://github.com/walkflow-app/ftms-treadmill/commit/11f674601a166336d72a3b0c53de9408073970f9))
* **start:** no Start when the start speed was not set, nothing on a moving belt ([#43](https://github.com/walkflow-app/ftms-treadmill/issues/43)) ([607b14f](https://github.com/walkflow-app/ftms-treadmill/commit/607b14f298d319779527b03d61efca289da6c490))
* **stop:** a Stop is not overtaken by Start, raw Stop is a Stop, connect() re-entrant, refused control ([#52](https://github.com/walkflow-app/ftms-treadmill/issues/52)) ([04b65bc](https://github.com/walkflow-app/ftms-treadmill/commit/04b65bcf84e355a826273d055c31fefea2e50db1))


### Fixes

* **pipeline:** a failed review is started again once, and a handed-back pull request gets a new window ([#57](https://github.com/walkflow-app/ftms-treadmill/issues/57)) ([fb3d2b6](https://github.com/walkflow-app/ftms-treadmill/commit/fb3d2b6de4f09aac01b3abdf1cf437fa958c5829))
* **pipeline:** port of walkflow[#121](https://github.com/walkflow-app/ftms-treadmill/issues/121) and [#122](https://github.com/walkflow-app/ftms-treadmill/issues/122), a conflict is solved before a kick and UNKNOWN waits ([#58](https://github.com/walkflow-app/ftms-treadmill/issues/58)) ([5cbdffe](https://github.com/walkflow-app/ftms-treadmill/commit/5cbdffed135b755bd08813043462f4512ee39075))

## [0.3.0](https://github.com/walkflow-app/ftms-treadmill/compare/v0.2.1...v0.3.0) (2026-11-22)


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
