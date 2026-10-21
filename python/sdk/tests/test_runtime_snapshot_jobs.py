import importlib.util
from pathlib import Path
import unittest


class JobSnapshotNormalizationTests(unittest.TestCase):
    def test_job_identity_relationships_and_lifecycle_clocks_survive_normalization(self):
        path = Path(__file__).resolve().parents[3] / "scripts" / "smoke-python-runtime.py"
        spec = importlib.util.spec_from_file_location("job_snapshot_smoke", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        records = [
            {"type": "jobs/registered", "data": {
                "registryEpoch": "epoch-one", "instanceId": "instance-one",
                "job": {"id": "bash-1", "startedAt": 123}, "terminalResult": "not-terminal",
            }},
            {"type": "tool/result", "data": {"meta": {"jobReceipt": {
                "registryEpoch": "epoch-one", "instanceId": "instance-one",
                "jobId": "bash-1", "terminalRead": "first",
            }}}},
            {"type": "jobs/registered", "data": {
                "registryEpoch": "epoch-two", "instanceId": "instance-two",
                "job": {"id": "bash-1", "startedAt": 456}, "terminalResult": "not-terminal",
            }},
        ]
        replacements = module.job_snapshot_replacements([records])
        normalized = module.normalize_snapshot_value(records, replacements)
        first = normalized[0]["data"]
        receipt = normalized[1]["data"]["meta"]["jobReceipt"]
        second = normalized[2]["data"]
        self.assertEqual(first["registryEpoch"], "{{job-registry:1}}")
        self.assertEqual(first["instanceId"], "{{job-instance:1}}")
        self.assertEqual(receipt["registryEpoch"], first["registryEpoch"])
        self.assertEqual(receipt["instanceId"], first["instanceId"])
        self.assertEqual(second["registryEpoch"], "{{job-registry:2}}")
        self.assertEqual(second["instanceId"], "{{job-instance:2}}")
        self.assertEqual(first["job"]["startedAt"], 0)
        self.assertEqual(receipt["jobId"], "bash-1")
        self.assertEqual(receipt["terminalRead"], "first")


if __name__ == "__main__":
    unittest.main()
