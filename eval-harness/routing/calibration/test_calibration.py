"""Guard calibration ordering, stable endpoints and interval interpretation."""
import math
import unittest
from calibrate import calibrated, logit
from report import wilson

class CalibrationTests(unittest.TestCase):
    def test_identity_inside_clipping_bounds(self):
        for p in [.01,.25,.5,.8,.99]:
            self.assertAlmostEqual(calibrated(p,1,0),p)

    def test_positive_slope_preserves_order(self):
        for a,b in [(.01,-20),(.5,0),(2,1),(20,20)]:
            values=[calibrated(p,a,b) for p in [0,.1,.3,.5,.8,.99,1]]
            self.assertEqual(values,sorted(values))
            self.assertTrue(all(math.isfinite(v) and 0<=v<=1 for v in values))

    def test_raw_cutoff_matches_calibrated_gate(self):
        for a,b in [(2,.7),(3.6,2.2),(.53,-.02)]:
            cutoff=1/(1+math.exp(-(logit(.8)-b)/a))
            self.assertLess(calibrated(cutoff-1e-5,a,b),.8)
            self.assertGreater(calibrated(cutoff+1e-5,a,b),.8)

    def test_perfect_small_sample_does_not_prove_perfection(self):
        self.assertIsNone(wilson(0,0))
        lo,hi=wilson(19,19)
        self.assertLess(lo,.85)
        self.assertAlmostEqual(hi,1)
        self.assertLess(wilson(19,19)[0],wilson(100,100)[0])

if __name__=='__main__':unittest.main()
