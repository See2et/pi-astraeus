import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("astraeus", ROOT / "scripts/astraeus.py")
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)


def review():
    return dict(schema_version=1, kind="review", task_id="t1", target_id="state1",
                status="complete", summary="Checked parser boundary.", verdict="pass",
                violations=[], bugs=[], suggestions=[], checked_scope=["parse.py:parse"],
                evidence=["Empty input is rejected at parse.py:12; regression check passed."], unresolved=[])


def decision(ref, action="reject"):
    return dict(ref=ref, action=action,
                basis="The user request and repository contract determine whether this finding is required.",
                evidence="The cited requirement and implementation were checked directly.",
                rationale="This disposition follows from the checked authority and evidence.")


def adjudication(review_path, decisions=None, **changes):
    data = dict(schema_version=1, kind="adjudication", task_id="t1", target_id="state1",
                status="complete", summary="Adjudicated every source finding.", verdict="accept",
                review_sha256="sha256:" + a.hashlib.sha256(review_path.read_bytes()).hexdigest(),
                decisions=[] if decisions is None else decisions,
                checked_scope=["Original request and review findings"],
                evidence=["Compared every finding with the controlling requirement."], unresolved=[])
    data.update(changes)
    return data


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "result.json"
        self.review_path = Path(self.tmp.name) / "review.json"

    def check_review(self, data, **kw):
        self.path.write_text(json.dumps(data))
        return a.validate_result(self.path, "review", "t1", "state1", **kw)

    def check_adjudication(self, data, source, **kw):
        self.review_path.write_text(json.dumps(source))
        if data is None:
            data = adjudication(self.review_path)
        self.path.write_text(json.dumps(data))
        return a.validate_result(self.path, "adjudication", "t1", "state1",
                                 review_result=self.review_path, **kw)

    def test_review_pass_with_optional_suggestions_is_valid_input(self):
        data = review()
        data["suggestions"] = ["Optional: shorten the helper name."]
        self.assertFalse(self.check_review(data)["acceptance_checks_passed"])
        self.assertTrue(self.check_review(data, accept=True)["acceptance_checks_passed"])

    def test_review_inconclusive_is_valid_input(self):
        data = review()
        data.update(verdict="inconclusive", unresolved=["Database was unavailable."])
        self.assertFalse(self.check_review(data)["acceptance_checks_passed"])

    def test_false_review_passes_rejected(self):
        modifications = [dict(status="blocked"), dict(evidence=[]), dict(checked_scope=[]),
                         dict(unresolved=["Missing evidence"]), dict(extra="ignored?"),
                         dict(target_id="stale"), dict(task_id="other"),
                         dict(bugs=[dict(location="p:1", claim="crashes", evidence="repro")])]
        for change in modifications:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.check_review(review() | change, accept=True)

    def test_duplicate_json_keys_rejected(self):
        self.path.write_text('{"verdict":"pass","verdict":"inconclusive"}')
        with self.assertRaises(ValueError):
            a.read_json(self.path)

    def test_changes_required_needs_concrete_finding(self):
        with self.assertRaises(ValueError):
            self.check_review(review() | dict(verdict="changes_required"))

    def test_rejected_invented_requirement_permits_acceptance(self):
        source = review() | dict(
            verdict="changes_required",
            violations=[dict(location="README.md:1", claim="Add an unrequested badge.",
                             evidence="The badge is absent.")])
        self.review_path.write_text(json.dumps(source))
        data = adjudication(self.review_path, [decision("violations/0")])
        result = self.check_adjudication(data, source, accept=True)
        self.assertTrue(result["acceptance_checks_passed"])

    def test_fix_decision_requires_changes_even_without_accept_flag(self):
        source = review() | dict(
            verdict="changes_required",
            bugs=[dict(location="parse.py:12", claim="Empty input crashes.", evidence="Reproduced.")])
        self.review_path.write_text(json.dumps(source))
        contradictory = adjudication(self.review_path, [decision("bugs/0", "fix")])
        with self.assertRaisesRegex(ValueError, "accept requires"):
            self.check_adjudication(contradictory, source)
        required = contradictory | dict(verdict="changes_required")
        self.assertFalse(self.check_adjudication(required, source)["acceptance_checks_passed"])
        with self.assertRaisesRegex(ValueError, "does not accept"):
            self.check_adjudication(required, source, accept=True)

    def test_every_source_item_has_exactly_one_disposition(self):
        source = review() | dict(
            verdict="changes_required",
            violations=[dict(location="a:1", claim="v", evidence="e")],
            bugs=[dict(location="b:2", claim="b", evidence="e")],
            suggestions=["s"], unresolved=["u"])
        self.review_path.write_text(json.dumps(source))
        complete = [decision("violations/0"), decision("bugs/0"),
                    decision("suggestions/0"), decision("unresolved/0")]
        cases = {
            "omitted": complete[:-1],
            "duplicate": complete + [decision("bugs/0")],
            "unknown": complete[:-1] + [decision("unresolved/1")],
        }
        for name, decisions in cases.items():
            data = adjudication(self.review_path, decisions, verdict="inconclusive",
                                unresolved=["Source review remains unresolved."])
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.check_adjudication(data, source)

    def test_source_hash_task_and_target_are_bound(self):
        source = review()
        self.review_path.write_text(json.dumps(source))
        data = adjudication(self.review_path)
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.check_adjudication(data | dict(review_sha256="sha256:" + "0" * 64), source)
        for change in (dict(task_id="other"), dict(target_id="stale")):
            changed_source = source | change
            self.review_path.write_text(json.dumps(changed_source))
            changed_data = data | dict(
                review_sha256="sha256:" + a.hashlib.sha256(self.review_path.read_bytes()).hexdigest())
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "task or target mismatch"):
                self.check_adjudication(changed_data, changed_source)

    def test_incomplete_source_review_cannot_be_waived(self):
        finding = [dict(location="p:1", claim="Needs change.", evidence="Observed.")]
        variations = [
            dict(status="blocked", verdict="changes_required", violations=finding),
            dict(verdict="inconclusive", violations=finding),
            dict(verdict="changes_required", violations=finding, unresolved=["Authority unknown."]),
            dict(verdict="changes_required", violations=finding, evidence=[]),
            dict(verdict="changes_required", violations=finding, checked_scope=[]),
        ]
        for change in variations:
            source = review() | change
            self.review_path.write_text(json.dumps(source))
            data = adjudication(self.review_path, [decision("violations/0")])
            if source["unresolved"]:
                data["decisions"].append(decision("unresolved/0"))
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "inconclusive"):
                self.check_adjudication(data, source)

    def test_pending_decisions_require_inconclusive(self):
        source = review() | dict(suggestions=["Consider another design."])
        self.review_path.write_text(json.dumps(source))
        for action in ("investigate", "human_decision"):
            data = adjudication(self.review_path, [decision("suggestions/0", action)])
            with self.subTest(action=action), self.assertRaisesRegex(ValueError, "inconclusive"):
                self.check_adjudication(data, source)
            data.update(verdict="inconclusive", unresolved=["Decision remains pending."])
            self.check_adjudication(data, source)

    def test_strict_acceptance_requires_both_host_receipts(self):
        source = review()
        self.review_path.write_text(json.dumps(source))
        data = adjudication(self.review_path)
        receipt_data = dict(requested=dict(model="gpt-6-astra", effort="high"),
                            observed=dict(model="gpt-6-astra", effort="high", sandbox="read-only"),
                            source="host response thread 123")
        receipt = Path(self.tmp.name) / "adjudicator-host.json"
        review_receipt = Path(self.tmp.name) / "reviewer-host.json"
        receipt.write_text(json.dumps(receipt_data))
        review_receipt.write_text(json.dumps(receipt_data))
        with self.assertRaisesRegex(ValueError, "requires --receipt"):
            self.check_adjudication(data, source, accept=True, assurance="strict")
        with self.assertRaisesRegex(ValueError, "requires --review-receipt"):
            self.check_adjudication(data, source, accept=True, assurance="strict", receipt=receipt)
        self.check_adjudication(data, source, accept=True, assurance="strict", receipt=receipt,
                                review_receipt=review_receipt)
        for option, path in (("--receipt", receipt), ("--review-receipt", review_receipt)):
            for change in (dict(model=None), dict(model="gpt-5.6-sol"),
                           dict(sandbox="workspace-write")):
                bad = copy.deepcopy(receipt_data)
                bad["observed"].update(change)
                path.write_text(json.dumps(bad))
                with self.subTest(option=option, change=change), self.assertRaisesRegex(ValueError, option):
                    self.check_adjudication(data, source, accept=True, assurance="strict", receipt=receipt,
                                            review_receipt=review_receipt)
                path.write_text(json.dumps(receipt_data))

    def test_review_acceptance_requires_pass(self):
        finding = dict(location="p:1", claim="crashes", evidence="repro")
        for change in (dict(verdict="changes_required", bugs=[finding]),
                       dict(verdict="inconclusive", unresolved=["Missing evidence"])):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "does not pass"):
                self.check_review(review() | change, accept=True)

    def test_strict_review_acceptance_requires_reviewer_receipt(self):
        with self.assertRaisesRegex(ValueError, "requires --receipt"):
            self.check_review(review(), accept=True, assurance="strict")
        receipt = Path(self.tmp.name) / "reviewer-host.json"
        receipt.write_text(json.dumps(dict(
            requested=dict(model="gpt-6-astra", effort="high"),
            observed=dict(model="gpt-6-astra", effort="high", sandbox="read-only"),
            source="host response thread 123")))
        self.assertTrue(self.check_review(review(), accept=True, assurance="strict",
                                         receipt=receipt)["acceptance_checks_passed"])

    def test_adjudication_only_arguments_are_rejected_for_review(self):
        with self.assertRaisesRegex(ValueError, "only for adjudication"):
            self.check_review(review(), review_result=self.review_path)
        self.path.write_text(json.dumps(review()))
        with self.assertRaisesRegex(ValueError, "requires --review-result"):
            a.validate_result(self.path, "adjudication", "t1", "state1")

    def test_all_schemas_and_examples(self):
        from jsonschema import Draft202012Validator, FormatChecker
        for kind in ("review", "adjudication", "exploration", "research", "implementation"):
            schema = a.read_json(a.PLUGIN / "schemas" / f"{kind}.json")
            Draft202012Validator.check_schema(schema)
            example = a.read_json(ROOT / "tests/python/fixtures" / f"{kind}.json")
            Draft202012Validator(schema, format_checker=FormatChecker()).validate(example)
        result = a.validate_result(ROOT / "tests/python/fixtures/adjudication.json", "adjudication",
                                   "example", "example-snapshot", accept=True,
                                   review_result=ROOT / "tests/python/fixtures/review.json")
        self.assertTrue(result["acceptance_checks_passed"])


class PolicyTests(unittest.TestCase):
    def test_defaults_are_adopted_automatic_candidates(self):
        self.assertEqual(a.policy(), a.DEFAULTS)
        self.assertEqual(a.policy()["allowed_models"],
                         ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"])
        self.assertNotIn("review_limit", a.policy())

    def test_explicit_legacy_policy_preserves_exact_provider_pin(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "astraeus.toml"
            p.write_text('allowed_models = ["openai/gpt-5.5", "openai/gpt-5.6-sol"]\n')
            self.assertEqual(a.policy(p)["allowed_models"],
                             ["openai/gpt-5.5", "openai/gpt-5.6-sol"])

    def test_invalid_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "config.toml"
            for text in ('allowed_models = []', 'unknown = 1', 'assurance = "magic"',
                         'allowed_models = ["x", "x"]', 'schema_version = true'):
                p.write_text(text)
                with self.subTest(text=text), self.assertRaises(ValueError):
                    a.policy(p)

    def test_retired_review_limit_requires_explicit_migration(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "astraeus.toml"
            for value in ("1", "2", "3", "0", "true"):
                p.write_text(f"review_limit = {value}\n")
                with self.subTest(value=value), self.assertRaisesRegex(
                        ValueError, "review_limit has been retired; remove it"):
                    a.policy(p)



class TargetTests(unittest.TestCase):
    def test_tracks_staged_untracked_and_unstaged_without_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / ".gitignore").write_text(".astraeus/\n")
            initial = a.target_id(root)
            (root / "file.txt").write_text("one")
            untracked = a.target_id(root)
            self.assertNotEqual(initial, untracked)
            subprocess.run(["git", "add", "file.txt"], cwd=root, check=True)
            staged = a.target_id(root)
            self.assertNotEqual(untracked, staged)
            (root / "file.txt").write_text("two")
            edited = a.target_id(root)
            self.assertNotEqual(staged, edited)
            (root / ".astraeus").mkdir()
            (root / ".astraeus/result.json").write_text("{}")
            self.assertEqual(edited, a.target_id(root))
            (root / "sub").mkdir()
            with self.assertRaises(ValueError):
                a.target_id(root / "sub")



class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo"
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)

    def test_policy_never_searches_parent_and_rejects_subdirectory(self):
        (Path(self.tmp.name) / "astraeus.toml").write_text('assurance = "strict"\n')
        self.assertEqual(a.project_policy(self.repo)["assurance"], "reported")
        (self.repo / "astraeus.toml").write_text('assurance = "strict"\n')
        self.assertEqual(a.project_policy(self.repo)["assurance"], "strict")
        (self.repo / "sub").mkdir()
        with self.assertRaisesRegex(ValueError, "repository root"):
            a.project_policy(self.repo / "sub")

    def test_matches_tracked_staged_untracked_and_deleted_case_sensitively(self):
        (self.repo / "astraeus.toml").write_text('require_review_globs = ["src/*", "gone.txt"]\n')
        (self.repo / "src/deep").mkdir(parents=True)
        (self.repo / "src/tracked.txt").write_text("initial")
        (self.repo / "gone.txt").write_text("initial")
        (self.repo / ".gitignore").write_text("ignored.txt\n")
        subprocess.run(["git", "add", "."], cwd=self.repo, check=True)
        subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                        "commit", "-qm", "initial"], cwd=self.repo, check=True)
        (self.repo / "src/tracked.txt").write_text("modified")
        (self.repo / "src/staged.txt").write_text("staged")
        subprocess.run(["git", "add", "src/staged.txt"], cwd=self.repo, check=True)
        (self.repo / "src/deep/untracked.txt").write_text("untracked")
        (self.repo / "gone.txt").unlink()
        (self.repo / "SRC.txt").write_text("case mismatch")
        (self.repo / "ignored.txt").write_text("ignored")
        result = a.matches_review(self.repo)
        self.assertTrue(result["requires_review"])
        self.assertEqual(result["paths"], ["gone.txt", "src/deep/untracked.txt", "src/staged.txt", "src/tracked.txt"])
        self.assertIn("SRC.txt", result["changed_paths"])
        self.assertNotIn("ignored.txt", result["changed_paths"])
        (self.repo / "astraeus.toml").write_text('require_review_globs = ["absent/*"]\n')
        self.assertFalse(a.matches_review(self.repo)["requires_review"])

    def test_rename_matches_original_mandatory_path(self):
        (self.repo / "astraeus.toml").write_text('require_review_globs = ["sensitive.txt"]\n')
        (self.repo / "sensitive.txt").write_text("preserved content")
        subprocess.run(["git", "add", "."], cwd=self.repo, check=True)
        subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                        "commit", "-qm", "initial"], cwd=self.repo, check=True)
        subprocess.run(["git", "mv", "sensitive.txt", "ordinary.txt"], cwd=self.repo, check=True)
        result = a.matches_review(self.repo)
        self.assertTrue(result["requires_review"])
        self.assertEqual(result["paths"], ["sensitive.txt"])
        self.assertEqual(result["changed_paths"], ["ordinary.txt", "sensitive.txt"])

    def test_bridges_reject_retired_limit_in_root_config(self):
        (self.repo / "astraeus.toml").write_text("review_limit = 2\n")
        for command in ("policy", "matches-review"):
            result = subprocess.run([sys.executable, str(ROOT / "scripts/astraeus.py"), command,
                                     "--repo", str(self.repo)], capture_output=True, text=True)
            with self.subTest(command=command):
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertIn("review_limit has been retired; remove it", result.stderr)

    def test_cli_is_json_and_does_not_offer_codex_maintenance(self):
        result = subprocess.run([sys.executable, str(ROOT / "scripts/astraeus.py"), "policy",
                                 "--repo", str(self.repo)], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), a.DEFAULTS)
        result = subprocess.run([sys.executable, str(ROOT / "scripts/astraeus.py"), "doctor"],
                                capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)["runtime_model"], "unknown")
        for command in ("activation", "plugin"):
            result = subprocess.run([sys.executable, str(ROOT / "scripts/astraeus.py"), command],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
