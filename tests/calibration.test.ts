import test from "node:test";
import assert from "node:assert/strict";
import {
	calibrateTokS,
	foldCalibration,
	type CalibrationState,
} from "../shared/calibration.ts";

function fresh(): CalibrationState {
	return { scale: 1, samples: 0, recent: [] };
}

test("foldCalibration: first sample sets the scale outright", () => {
	const s = fresh();
	foldCalibration(s, 100, 250); // estimator under-counted 2.5x
	assert.equal(s.scale, 2.5);
	assert.equal(s.samples, 1);
});

test("foldCalibration: later samples EWMA toward new ratio", () => {
	const s = fresh();
	foldCalibration(s, 100, 250); // scale 2.5
	foldCalibration(s, 100, 100); // this sample ratio = 1
	// EWMA: 2.5*0.8 + 1*0.2 = 2.2
	assert.ok(Math.abs(s.scale - 2.2) < 1e-9);
	assert.equal(s.samples, 2);
});

test("foldCalibration: ignores degenerate inputs", () => {
	const s = fresh();
	foldCalibration(s, 0, 100);
	foldCalibration(s, 100, 0);
	foldCalibration(s, -5, 50);
	assert.equal(s.scale, 1);
	assert.equal(s.samples, 0);
});

test("calibrateTokS: scales estimation and passes through null", () => {
	assert.equal(calibrateTokS(null, fresh()), null);
	assert.equal(calibrateTokS(40, { scale: 2.5, samples: 5, recent: [] }), 100);
	// default scale 1 = identity
	assert.equal(calibrateTokS(40, fresh()), 40);
});
