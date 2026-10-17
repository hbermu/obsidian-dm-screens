import unittest

from enrich import (
    DEFAULT_LAYOUT, group_by_tags, normalise, parse_layout, plan, singular, tags_for_path, withhold_deleted,
)

LAYOUT = parse_layout(DEFAULT_LAYOUT)


def tags(rel, layout=LAYOUT):
    return tags_for_path(rel, layout)


class LayoutTest(unittest.TestCase):
    def test_maps_segments_onto_placeholders(self):
        self.assertEqual(
            tags("Czepeku/Fantasy/Battlemaps/Abbey Prison/abbey.jpg"),
            ["artist:czepeku", "genre:fantasy", "type:battlemap", "name:abbey prison"],
        )

    def test_custom_namespaces(self):
        layout = parse_layout("{creator}/{name}")
        self.assertEqual(tags("Some Artist/Old Mill/mill.png", layout), ["creator:some artist", "name:old mill"])

    def test_path_too_short_is_skipped(self):
        self.assertIsNone(tags("Czepeku/Fantasy/stray.jpg"))

    def test_literal_segment_must_match(self):
        layout = parse_layout("maps/{artist}/{name}")
        self.assertEqual(tags("maps/Czepeku/Old Mill/a.jpg", layout), ["artist:czepeku", "name:old mill"])
        self.assertIsNone(tags("tokens/Czepeku/Old Mill/a.jpg", layout))
        self.assertIsNone(tags("Maps/Czepeku/Old Mill/a.jpg", layout))

    def test_deeper_segments_belong_to_the_map(self):
        self.assertEqual(
            tags("Czepeku/Fantasy/Battlemaps/Abbey Prison/Extras/Floor 2/a.jpg"),
            ["artist:czepeku", "genre:fantasy", "type:battlemap", "name:abbey prison"],
        )

    def test_plan_splits_matched_and_skipped(self):
        planned, skipped = plan(["a/b/c/d/x.jpg", "a/x.jpg"], LAYOUT)
        self.assertEqual(list(planned), ["a/b/c/d/x.jpg"])
        self.assertEqual(skipped, ["a/x.jpg"])


class NormaliseTest(unittest.TestCase):
    def test_lowercase_underscores_whitespace(self):
        self.assertEqual(normalise("  Ages_of the   Vale_ Tavern "), "ages of the vale tavern")

    def test_type_is_singularised(self):
        self.assertEqual(singular("scenes"), "scene")
        self.assertEqual(singular("battlemaps"), "battlemap")
        self.assertEqual(singular("fortress"), "fortress")
        self.assertEqual(tags("A/B/Scenes/Old Mill/x.jpg")[2], "type:scene")

    def test_only_type_is_singularised(self):
        self.assertIn("name:old mills", tags("A/B/C/Old_Mills/x.jpg"))


class GridTest(unittest.TestCase):
    def test_grid_folders(self):
        self.assertIn("grid:gridded", tags("A/B/C/Mill/Gridded/mill.jpg"))
        self.assertIn("grid:gridless", tags("A/B/C/Mill/gridless/mill.jpg"))

    def test_grid_prefixes(self):
        self.assertIn("grid:gridded", tags("A/B/C/Mill/G_Mill.jpg"))
        self.assertIn("grid:gridless", tags("A/B/C/Mill/GL_Mill.jpg"))
        self.assertFalse(any(t.startswith("grid:") for t in tags("A/B/C/Mill/Gate_Mill.jpg")))

    def test_grid_size(self):
        self.assertIn("grid:30x20", tags("A/B/C/Mill/Mill_30x20.jpg"))
        self.assertIn("grid:30x20", tags("A/B/C/Mill/Mill 30X20 night.jpg"))

    def test_resolution_is_not_a_grid_size(self):
        self.assertNotIn("grid:1920x1080", tags("A/B/C/Mill/Mill_1920x1080.jpg"))


class VariantTest(unittest.TestCase):
    def test_modifiers_after_the_name(self):
        result = tags("A/B/C/Abbey Prison/Gridded/G_AbbeyPrison_Night_Rain.jpg")
        self.assertEqual(result[-2:], ["night", "rain"])

    def test_name_words_are_not_variants(self):
        result = tags("A/B/C/Night Market/NightMarket_Original.jpg")
        self.assertNotIn("night", result)
        self.assertIn("original", result)

    def test_name_words_without_a_prefix(self):
        result = tags("A/B/C/Night Market/market_at_night.jpg")
        self.assertNotIn("night", result)

    def test_variant_equal_to_a_name_word_after_the_prefix(self):
        self.assertIn("night", tags("A/B/C/Night Market/Night Market Night.jpg"))

    def test_unknown_words_are_ignored(self):
        result = tags("A/B/C/Mill/Mill_Upstairs_Fog.jpg")
        self.assertIn("fog", result)
        self.assertNotIn("upstairs", result)


class ZipTest(unittest.TestCase):
    def test_zip_is_a_foundry_module_with_the_map_name(self):
        self.assertEqual(
            tags("Czepeku/Fantasy/Battlemaps/Abbey Prison/abbey-prison-module.zip"),
            ["artist:czepeku", "genre:fantasy", "name:abbey prison", "type:foundry module"],
        )

    def test_zip_gets_no_grid_or_variant(self):
        result = tags("A/B/C/Mill/Gridded/G_Mill_Night_30x20.zip")
        self.assertEqual(result, ["artist:a", "genre:b", "name:mill", "type:foundry module"])


class GroupTest(unittest.TestCase):
    def test_identical_tag_lists_share_a_request(self):
        groups = group_by_tags({"h1": ["a", "b"], "h2": ["a", "b"], "h3": ["c"]})
        self.assertEqual(groups, {("a", "b"): ["h1", "h2"], ("c",): ["h3"]})


class WithholdDeletedTest(unittest.TestCase):
    def test_deleted_tags_are_withheld(self):
        kept, withheld = withhold_deleted({"h1": ["name:mill", "night"]}, {"h1": {"night"}})
        self.assertEqual(kept, {"h1": ["name:mill"]})
        self.assertEqual(withheld, 1)

    def test_unknown_files_are_dropped(self):
        kept, withheld = withhold_deleted({"h1": ["a"], "h2": ["b"]}, {"h1": set()})
        self.assertEqual(kept, {"h1": ["a"]})
        self.assertEqual(withheld, 0)

    def test_file_with_every_tag_deleted_is_skipped(self):
        kept, withheld = withhold_deleted({"h1": ["a", "b"]}, {"h1": {"a", "b", "c"}})
        self.assertEqual(kept, {})
        self.assertEqual(withheld, 2)


if __name__ == "__main__":
    unittest.main()
